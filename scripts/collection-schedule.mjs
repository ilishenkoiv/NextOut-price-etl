// Shared sequential scheduling core. No network, environment secrets or process
// side effects on import. Adapters perform one bounded, checkpointed unit at a time.
const MINUTE = 60_000;
export const CYCLE_MS = 120 * MINUTE;
// export const MAIN_CYCLE_MS = 12 * 60 * MINUTE; // two main passes/day — uncomment to restore
export const MAIN_CYCLE_MS = 24 * 60 * MINUTE;    // one main pass/day
export const SLOTS = Object.freeze([
  { from: 0, to: 10, task: 'fast' },
  { from: 10, to: 15, task: 'maintenance' },
  { from: 15, to: 45, task: 'main' },
  { from: 45, to: 65, task: 'tail' },
  { from: 65, to: 70, task: 'maintenance' },
  { from: 70, to: 95, task: 'main' },
  { from: 95, to: 110, task: 'tail' },
  { from: 110, to: 120, task: 'reserve' },
]);

export function slotAt(timestamp) {
  if (!Number.isFinite(timestamp) || timestamp < 0) throw new Error('Invalid clock');
  const cycle = Math.floor(timestamp / CYCLE_MS);
  const start = cycle * CYCLE_MS;
  const minute = (timestamp - start) / MINUTE;
  const slot = SLOTS.find(s => minute >= s.from && minute < s.to);
  return { ...slot, cycle, deadline: start + slot.to * MINUTE };
}

export function freshScheduleState() {
  return { version: 1, jobs: {}, completedMain: 0, missedFast: 0 };
}

function newJob(task, id, timestamp) {
  return { id, planDate: new Date(timestamp).toLocaleDateString('en-CA',{timeZone:'Europe/Berlin'}),
    checkpoint: null, done: false, startedAt: timestamp, completedAt: null, retryAt: 0, activeMs: 0 };
}

export function prepareJob(state, task, timestamp) {
  const current = state.jobs[task];
  const period = task === 'fast' ? CYCLE_MS : task === 'main' ? MAIN_CYCLE_MS : 86400000;
  const requestedId = Math.floor(timestamp / period);
  if (task === 'fast' && current && current.id !== requestedId)
    state.missedFast += Math.max(0,requestedId-current.id-(current.done?1:0));
  // An unfinished main/tail/maintenance pass survives midnight, missed slots and
  // runner replacement. Never advance its plan date just because time advanced.
  if (current && (current.id === requestedId || (!current.done && task !== 'fast'))) return current;
  return (state.jobs[task] = newJob(task, requestedId, timestamp));
}

// Each invocation handles at most ONE unit. The caller persists state externally
// between runner sessions, holds the global lease, and supplies bounded adapters.
// save() must be fenced by that lease; a failed save throws and stops the worker.
export class SequentialSchedule {
  #busy = false;
  constructor({ state = freshScheduleState(), clock = Date.now, lease, save, handlers, stopAt = Infinity }) {
    this.state = state;
    this.clock = clock;
    this.lease = lease;
    this.save = save;
    this.handlers = handlers;
    this.stopAt = stopAt;
  }

  async tick() {
    if (this.#busy) throw new Error('Concurrent schedule ticks are forbidden');
    this.#busy = true;
    try {
      if (!await this.lease()) throw new Error('Collection lease unavailable');
      const cycle = slotAt(this.clock()).cycle;
      const cycleEnd = Math.min((cycle+1)*CYCLE_MS,this.stopAt);
      let working=structuredClone(this.state);
      if(working.frame?.cycle!==cycle)working.frame={cycle,phase:0,spentMs:0};
      // Track useful time, not a sleeping/deallocated runner. A five-minute
      // GitHub handover must not consume the fast refresh's ten-minute budget.
      while(working.frame.phase<SLOTS.length){
      const phase=SLOTS[working.frame.phase];
      const reserve=phase.task==='reserve';
      const remaining=reserve?Infinity:(phase.to-phase.from)*MINUTE-working.frame.spentMs;
      const candidates=reserve?['fast','main','tail','maintenance']:[phase.task];
      for(const task of candidates){
        const adapter = this.handlers[task];
        if (!adapter) continue;
        const next = structuredClone(working);
        const job = prepareJob(next, task, this.clock());
        if (job.done || job.retryAt > this.clock()) continue;
        const maxUnitMs = typeof adapter.maxUnitMs==='function' ? adapter.maxUnitMs(job) : adapter.maxUnitMs;
        if (!Number.isFinite(maxUnitMs) || maxUnitMs <= 0) throw new Error('Unbounded collection adapter');
        const taskBudget=task==='fast'?600000-(job.activeMs??0):Infinity;
        const deadline=Math.min(cycleEnd,this.clock()+remaining,this.clock()+taskBudget);
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
        if(!reserve&&['done','empty','yield'].includes(result.status))after.frame={cycle,phase:after.frame.phase+1,spentMs:0};
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
      if(working.frame.phase===SLOTS.indexOf(phase))working.frame={cycle,phase:working.frame.phase+1,spentMs:0};
      }
      await this.save(working);this.state=working;
      return { task: null, status: 'idle', cycle, deadline:cycleEnd };
    } finally { this.#busy = false; }
  }
}
