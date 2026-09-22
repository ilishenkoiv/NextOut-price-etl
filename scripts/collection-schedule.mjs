// Shared sequential scheduling core. No network, environment secrets or process
// side effects on import. Adapters perform one bounded, checkpointed unit at a time.
const MINUTE = 60_000;
export const CYCLE_MS = 30 * MINUTE;
// export const MAIN_CYCLE_MS = 12 * 60 * MINUTE; // two main passes/day — uncomment to restore
export const MAIN_CYCLE_MS = 24 * 60 * MINUTE;    // one main pass/day
// Reserve kept when judging whether the current main pass can still finish within MAIN_CYCLE_MS.
// A pass is "at risk" once its realized pace can no longer reach the end with this much slack.
export const MAIN_DEADLINE_RESERVE = 0.2;
export const PRIORITY_MAX_CYCLE_MS = 5 * MINUTE;
export const LOWER_PHASE_RESERVE_MS = 2 * MINUTE;
export const SLOTS = Object.freeze([
  { from: 0, to: 2, task: 'priority' },
  { from: 2, to: 4, task: 'fast' },
  { from: 4, to: 27, task: 'main' },
  { from: 27, to: 28, task: 'tail' },
  { from: 28, to: 29, task: 'maintenance' },
  { from: 29, to: 30, task: 'reserve' },
]);

// Exact nominal allocation for a session. Priority work may pre-empt any lower-priority slot;
// those overruns are deliberately reported as lag instead of being hidden in the MAIN budget.
export function nominalSessionBudgets(start, durationMs) {
  const budgets = {};
  let cursor = start; const end = start + durationMs;
  while (cursor < end) {
    const slot = slotAt(cursor);
    const until = Math.min(end, slot.deadline);
    budgets[slot.task] = (budgets[slot.task] ?? 0) + until - cursor;
    cursor = until;
  }
  return budgets;
}

export function priorityCycleProjection({ auditTickets = 1, rouletteTickets = 0, windowTickets = 0, requestMs }) {
  if (![auditTickets,rouletteTickets,windowTickets,requestMs].every(Number.isFinite) || requestMs < 0) throw new Error('Invalid priority projection');
  const windowBatch=Math.ceil(Math.max(0,windowTickets)/48);
  const requests=Math.max(0,auditTickets)+Math.max(0,rouletteTickets)+windowBatch;
  const elapsedMs=requests*requestMs;
  return{requests,windowBatch,elapsedMs,lagMs:Math.max(0,elapsedMs-2*MINUTE),fitsReservedSlot:elapsedMs<=2*MINUTE};
}

// Capacity proof from production-measured sequential throughput. Unlike the older /48 planning
// projection above, this models the actual recurring 30-minute cycle: audit and roulette freshness
// are paid again every cycle before any selected-window group can advance.
export function measuredPriorityCapacity({windowGroups,rouletteTickets=220,auditTickets=10,requestsPerMinute,
  priorityMinutes=5,targetMinutes=30}){
  if(![windowGroups,rouletteTickets,auditTickets,requestsPerMinute,priorityMinutes,targetMinutes].every(Number.isFinite)
    ||windowGroups<0||rouletteTickets<0||auditTickets<0||requestsPerMinute<=0||priorityMinutes<=0||targetMinutes<=0)
    throw new Error('Invalid measured capacity');
  const recurringRequests=rouletteTickets+auditTickets;
  const totalRequests=windowGroups+recurringRequests;
  const priorityCapacity=Math.floor(requestsPerMinute*priorityMinutes);
  const windowCapacity=Math.max(0,priorityCapacity-recurringRequests);
  const cycles=windowGroups===0?1:windowCapacity===0?Infinity:Math.ceil(windowGroups/windowCapacity);
  return{recurringRequests,totalRequests,priorityCapacity,windowCapacity,cycles,
    fullRefreshMinutes:cycles*targetMinutes,exclusiveMinutes:totalRequests/requestsPerMinute,
    requiredExclusiveRequestsPerMinute:totalRequests/targetMinutes,
    requiredBudgetRequestsPerMinute:totalRequests/priorityMinutes};
}

export function slotAt(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error('Invalid clock');
  const cycle = Math.floor(timestamp / CYCLE_MS);
  const start = cycle * CYCLE_MS;
  const minute = (timestamp - start) / MINUTE;
  const slot = SLOTS.find(s => minute >= s.from && minute < s.to);
  return { ...slot, cycle, deadline: start + slot.to * MINUTE };
}

export function freshScheduleState() {
  return { version: 1, jobs: {}, completedMain: 0, missedFast: 0, missedPriority: 0 };
}

function newJob(task, id, timestamp) {
  return { id, planDate: new Date(timestamp).toLocaleDateString('en-CA',{timeZone:'Europe/Berlin'}),
    checkpoint: null, done: false, startedAt: timestamp, completedAt: null, retryAt: 0, activeMs: 0 };
}

export function prepareJob(state, task, timestamp) {
  const current = state.jobs[task];
  const period = task === 'priority' ? CYCLE_MS : task === 'fast' ? 4*CYCLE_MS : task === 'main' ? MAIN_CYCLE_MS : 86400000;
  const requestedId = Math.floor(timestamp / period);
  if (task === 'fast' && current && current.id !== requestedId)
    state.missedFast += Math.max(0,requestedId-current.id-(current.done?1:0));
  if (task === 'priority' && current && current.id !== requestedId)
    state.missedPriority += Math.max(0,requestedId-current.id-(current.done?1:0));
  // An unfinished main/tail/maintenance pass survives midnight, missed slots and
  // runner replacement. Never advance its plan date just because time advanced.
  if (current && (current.id === requestedId || (!current.done && task !== 'fast' && task !== 'priority'))) return current;
  const next = newJob(task, requestedId, timestamp);
  // The daily weekend-refresh cursor lives across 30-minute priority cycles. Each cycle gets a
  // fresh due/deadline identity while retaining the stable daily-set checkpoint.
  if (task === 'priority' && current?.checkpoint) next.checkpoint = structuredClone(current.checkpoint);
  return (state.jobs[task] = next);
}

// Whether the current main pass is behind the pace needed to finish within MAIN_CYCLE_MS.
// It uses the pass's REALIZED wall-clock rate (cells committed / wall-time since the pass started),
// which already bakes in every real gap: hours with no runner at all, tail/fast sharing, GitHub
// start delay, DB retries. If the cells still reachable before the 24h deadline at that realized
// rate fall short of what remains (plus a reserve margin), main must take priority over tail.
// Pure: reads state, never mutates. Returns false until there is a measured pace and false once
// main is done — so it can never fabricate risk before the pass has run, nor after it finished.
export function mainAtRisk(state, clock, { margin = MAIN_DEADLINE_RESERVE } = {}) {
  const job = state?.jobs?.main;
  if (!job || job.done) return false;
  const cp = job.checkpoint;
  const total = Number(cp?.total);
  const cursor = Number(cp?.cursor ?? 0);
  if (!(total > 0)) return false;                       // plan size not known yet
  const remainingCells = total - cursor;
  if (remainingCells <= 0) return false;
  const remainingWall = (job.startedAt + MAIN_CYCLE_MS) - clock;
  if (remainingWall <= 0) return true;                  // already past the 24h deadline → rush
  const wallElapsed = clock - job.startedAt;
  if (!(cursor > 0) || wallElapsed <= 0) return false;  // no realized pace yet
  const reachable = (cursor / wallElapsed) * remainingWall;
  return reachable < remainingCells * (1 + margin);
}

// Each invocation handles at most ONE unit. The caller persists state externally
// between runner sessions, holds the global lease, and supplies bounded adapters.
// save() must be fenced by that lease; a failed save throws and stops the worker.
export class SequentialSchedule {
  #busy = false;
  constructor({ state = freshScheduleState(), clock = Date.now, lease, save, handlers, stopAt = Infinity,
    guaranteeDailyMain = false, mainDeadlineReserve = MAIN_DEADLINE_RESERVE }) {
    this.state = state;
    this.clock = clock;
    this.lease = lease;
    this.save = save;
    this.handlers = handlers;
    this.stopAt = stopAt;
    // When true, a `tail` slot yields to `main` while the current main pass is at risk of missing
    // its 24h deadline (mainAtRisk). Default false = exact legacy behavior (no regression).
    this.guaranteeDailyMain = guaranteeDailyMain;
    this.mainDeadlineReserve = mainDeadlineReserve;
  }

  async tick() {
    if (this.#busy) throw new Error('Concurrent schedule ticks are forbidden');
    this.#busy = true;
    try {
      if (!await this.lease()) throw new Error('Collection lease unavailable');
      const cycle = slotAt(this.clock()).cycle;
      const cycleEnd = Math.min((cycle+1)*CYCLE_MS,this.stopAt);
      let working=structuredClone(this.state);
      if(working.frame?.cycle!==cycle)working.frame={cycle,phase:0,spentMs:0,prioritySpentMs:0};
      // Track useful time, not a sleeping/deallocated runner. A five-minute
      // GitHub handover must not consume the fast refresh's ten-minute budget.
      while(working.frame.phase<SLOTS.length){
      const phase=SLOTS[working.frame.phase];
      const reserve=phase.task==='reserve';
      const remaining=reserve?Infinity:(phase.to-phase.from)*MINUTE-working.frame.spentMs;
      // A due priority cycle (audit -> cheapest -> saved windows) drains before every lower task.
      // This is one owner using one provider/lease; it cannot overlap MAIN or a second refresh.
      const priority = prepareJob(working, 'priority', this.clock());
      const priorityMaxUnit=typeof this.handlers.priority?.maxUnitMs==='function'
        ? this.handlers.priority.maxUnitMs(priority):this.handlers.priority?.maxUnitMs;
      const priorityDue = Boolean(this.handlers.priority) && !priority.done && priority.retryAt <= this.clock()
        && (working.frame.prioritySpentMs??0)+(Number(priorityMaxUnit)||Infinity)<=PRIORITY_MAX_CYCLE_MS;
      // A tail slot yields to main while the current main pass is at risk of missing its 24h
      // deadline (only when guaranteeDailyMain is on). Main is tried first; tail stays the fallback,
      // so an already-safe or done main lets tail keep its own cursor and run normally.
      const tailYieldsToMain = phase.task==='tail' && this.guaranteeDailyMain
        && mainAtRisk(working, this.clock(), { margin: this.mainDeadlineReserve });
      const candidates=priorityDue?['priority']:(reserve?['fast','main','tail','maintenance']:(tailYieldsToMain?['main','tail']:[phase.task]));
      for(const task of candidates){
        const adapter = this.handlers[task];
        if (!adapter) continue;
        const next = structuredClone(working);
        const job = prepareJob(next, task, this.clock());
        if (job.done || job.retryAt > this.clock()) continue;
        const maxUnitMs = typeof adapter.maxUnitMs==='function' ? adapter.maxUnitMs(job) : adapter.maxUnitMs;
        if (!Number.isFinite(maxUnitMs) || maxUnitMs <= 0) throw new Error('Unbounded collection adapter');
        const taskBudget=task==='fast'?600000-(job.activeMs??0):Infinity;
        const priorityRemaining=task==='priority'?PRIORITY_MAX_CYCLE_MS-(working.frame.prioritySpentMs??0):Infinity;
        const taskCycleEnd=task==='main'&&phase.task==='main'?cycleEnd-LOWER_PHASE_RESERVE_MS:cycleEnd;
        const deadline=Math.min(taskCycleEnd,this.clock()+remaining,this.clock()+taskBudget,this.clock()+priorityRemaining);
        if (this.clock() + maxUnitMs > deadline) continue;
        const unitStarted=this.clock();
        // Persist the selected plan BEFORE provider work so retries use exactly
        // the same plan/date. Adapters commit rows BEFORE returning a checkpoint.
        await this.save(next);
        this.state = next;
        if (!await this.lease()) throw new Error('Collection lease lost before unit');
        const result = await adapter.step({ job: structuredClone(job), deadline });
        if (!result || !['progress', 'done', 'empty', 'yield'].includes(result.status)) throw new Error('Invalid adapter result');
        if (!await this.lease()) throw new Error('Collection lease lost after unit');
        const after = structuredClone(this.state);
        const spent=Math.max(0,this.clock()-unitStarted);
        after.frame.spentMs+=spent;
        if(task==='priority')after.frame.prioritySpentMs=(after.frame.prioritySpentMs??0)+spent;
        after.jobs[task].activeMs=(after.jobs[task].activeMs??0)+spent;
        if (Object.hasOwn(result, 'checkpoint')) after.jobs[task].checkpoint = result.checkpoint;
        if (result.status === 'empty' || result.status === 'yield') {
          after.jobs[task].retryAt = this.clock() + 60_000;
        }
        if (result.status === 'done') {
          after.jobs[task].done = true;
          after.jobs[task].completedAt = this.clock();
          if (task === 'main') {
            after.completedMain += 1;
            after.mainCompletions=[...(after.mainCompletions??[]),{id:job.id,startedAt:job.startedAt,completedAt:this.clock(),
              errors:after.jobs[task].checkpoint?.errors??0,wave:after.jobs[task].checkpoint?.wave??0,
              activeMs:after.jobs[task].activeMs}].slice(-16);
          }
        }
        if(!reserve&&task===phase.task&&['done','empty','yield'].includes(result.status))after.frame={cycle,phase:after.frame.phase+1,spentMs:0,prioritySpentMs:after.frame.prioritySpentMs??0};
        await this.save(after);
        this.state = after;
        // Budget overruns are observable failures, not silent claims of on-time
        // refresh. Already committed data/checkpoint are retained for recovery.
        if (this.clock() > deadline) throw new Error(`Collection ${task} exceeded its slot`);
        working=after;
        if (result.status === 'empty' || result.status === 'yield') break;
        return { task, status: result.status, cycle, deadline };
      }
      if(reserve)break;
      // A completed/empty/unavailable task lends the rest of its budget to the
      // later phases. An unfinished job's checkpoint stays intact.
      if(working.frame.phase===SLOTS.indexOf(phase))working.frame={cycle,phase:working.frame.phase+1,spentMs:0,prioritySpentMs:working.frame.prioritySpentMs??0};
      }
      await this.save(working);this.state=working;
      return { task: null, status: 'idle', cycle, deadline:cycleEnd };
    } finally { this.#busy = false; }
  }
}
