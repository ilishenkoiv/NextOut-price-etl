import test from 'node:test';
import assert from 'node:assert/strict';
import { SequentialSchedule, freshScheduleState, prepareJob, slotAt, SLOTS, CYCLE_MS, MAIN_CYCLE_MS, PRIORITY_MAX_CYCLE_MS, mainAtRisk, nominalSessionBudgets,
  priorityCycleProjection, measuredPriorityCapacity, projectMonthlyRunnerUsage, nextPriorityDueAt, offCycleMainBudget, runBoundedMainAdvance } from './collection-schedule.mjs';

test('a cycle has the agreed budgets and no overlaps or holes', () => {
  let end = 0;
  const budgets = {};
  for (const slot of SLOTS) {
    assert.equal(slot.from, end);
    end = slot.to;
    budgets[slot.task] = (budgets[slot.task] ?? 0) + slot.to - slot.from;
  }
  assert.equal(end, 30);
  assert.deepEqual(budgets, { priority: 2, fast: 2, main: 23, tail: 1, maintenance: 1, reserve: 1 });
  assert.equal(slotAt(2 * 60000).task, 'fast');
  assert.equal(slotAt(CYCLE_MS).task, 'priority');
  const session=nominalSessionBudgets(7*60000,235*60000);
  assert.equal(session.main/60000,181);
});

test('priority capacity is honest at maximum backlog: realistic latency fits, timeout latency conflicts with MAIN',()=>{
  const realistic=priorityCycleProjection({auditTickets:0,rouletteTickets:220,windowTickets:459,replacementRequests:264,requestMs:60000/89});
  assert.deepEqual({requests:realistic.requests,windowRequests:realistic.windowRequests,fits:realistic.fitsReservedSlot},
    {requests:943,windowRequests:459,fits:true});
  assert.ok(realistic.elapsedMs>10*60000&&realistic.elapsedMs<11*60000,'live workload fits in about 10.6 minutes');
  const timeout=priorityCycleProjection({auditTickets:10,rouletteTickets:220,windowTickets:459,replacementRequests:264,requestMs:8000});
  assert.equal(timeout.fitsReservedSlot,false);assert.ok(timeout.elapsedMs>30*60000);
});

test('monthly runner projection records 5/10/15/30-minute trigger cost with immediate no-due exits',()=>{
  const rows=[5,10,15,30].map(triggerMinutes=>projectMonthlyRunnerUsage({triggerMinutes}));
  assert.deepEqual(rows.map(r=>[r.triggerMinutes,r.triggers,r.rawRunnerMinutes,r.roundedJobMinutes]),[
    [5,8640,37200,43200],[10,4320,36480,38880],[15,2880,36240,37440],[30,1440,36000,36000]]);
});

test('measured post-priority MAIN capacity preserves the mandatory daily pass with reserve',()=>{
  const measuredCellsPerMinute=45,mainMinutesPerCycle=10,cyclesPerDay=48,total=17730;
  const capacity=measuredCellsPerMinute*mainMinutesPerCycle*cyclesPerDay;
  assert.ok(capacity>=total*1.2,{capacity,required:total*1.2});
});

test('measured cache-inventory scenario includes recurring roulette/audit cost before window progress',()=>{
  const measured=measuredPriorityCapacity({windowGroups:2591,rouletteTickets:220,auditTickets:10,requestsPerMinute:67.1,priorityMinutes:5});
  assert.deepEqual({recurring:measured.recurringRequests,cap:measured.priorityCapacity,windows:measured.windowCapacity,cycles:measured.cycles},
    {recurring:230,cap:335,windows:105,cycles:25});
  assert.equal(measured.fullRefreshMinutes,750);
  assert.ok(measured.exclusiveMinutes>42&&measured.exclusiveMinutes<42.1);
  assert.ok(measured.requiredExclusiveRequestsPerMinute>94);
  assert.ok(measured.requiredBudgetRequestsPerMinute>562);
  const preserveMain=measuredPriorityCapacity({windowGroups:2591,requestsPerMinute:67.1,priorityMinutes:2});
  assert.equal(preserveMain.windowCapacity,0,'two-minute priority allowance cannot even pay recurring roulette+audit');
  assert.equal(preserveMain.cycles,Infinity);
});

test('unfinished main retains its date and cursor across midnight and a new runner', () => {
  const state = freshScheduleState();
  const old = prepareJob(state, 'main', Date.parse('2026-09-16T21:00:00Z'));
  old.checkpoint = { month: 3, route: 18 };
  const restored = JSON.parse(JSON.stringify(state));
  const next = prepareJob(restored, 'main', Date.parse('2026-09-17T02:00:00Z'));
  assert.equal(next.id, old.id);
  assert.equal(next.planDate, '2026-09-16');
  assert.deepEqual(next.checkpoint, { month: 3, route: 18 });
});

test('plan month follows Berlin while cycle IDs remain monotonic through DST',()=>{
  const state=freshScheduleState();
  assert.equal(prepareJob(state,'main',Date.parse('2026-09-30T22:30:00Z')).planDate,'2026-10-01');
  const a=slotAt(Date.parse('2026-10-25T00:00:00Z'));
  const b=slotAt(Date.parse('2026-10-25T02:00:00Z'));
  assert.equal(b.cycle-a.cycle,4);
});

test('fast checkpoints retain the established two-hour cadence inside 30-minute priority cycles', () => {
  const state = freshScheduleState();
  const first = prepareJob(state, 'fast', 0);
  first.done = true;
  assert.equal(prepareJob(state, 'fast', 60000).done, true);
  assert.equal(prepareJob(state, 'fast', 4*CYCLE_MS).done, false);
  prepareJob(state, 'fast', 8*CYCLE_MS);
  assert.equal(state.missedFast, 1);
});

test('unknown lease means no provider work or state write', async () => {
  let calls = 0;
  const engine = new SequentialSchedule({ clock: () => 0, lease: async () => false,
    save: async () => calls++, handlers: { fast: { maxUnitMs: 1, step: async () => calls++ } } });
  await assert.rejects(engine.tick(), /lease/);
  assert.equal(calls, 0);
});

test('second caller cannot execute while first unit is in flight', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const engine = new SequentialSchedule({ clock: () => 0, lease: async () => true,
    save: async () => {}, handlers: { fast: { maxUnitMs: 100, step: async () => { await pending; return { status: 'progress', checkpoint: 1 }; } } } });
  const first = engine.tick();
  await assert.rejects(engine.tick(), /Concurrent/);
  release();
  await first;
  assert.equal(engine.state.jobs.fast.checkpoint, 1);
});

test('save failure before work prevents the provider request', async () => {
  let calls = 0;
  const engine = new SequentialSchedule({ clock: () => 0, lease: async () => true,
    save: async () => { throw new Error('storage unavailable'); },
    handlers: { fast: { maxUnitMs: 100, step: async () => { calls++; return { status: 'done' }; } } } });
  await assert.rejects(engine.tick(), /storage/);
  assert.equal(calls, 0);
});

test('does not begin a unit that cannot fit before preemption', async () => {
  let calls = 0;
  const state = freshScheduleState(); prepareJob(state,'fast',0);
  const engine = new SequentialSchedule({ state, clock: () => 599999, stopAt:600000, lease: async () => true,
    save: async () => {}, handlers: { fast: { maxUnitMs: 5000, step: async () => calls++ } } });
  assert.equal((await engine.tick()).status, 'idle');
  assert.equal(calls, 0);
});

test('late GitHub start immediately services the due fast cycle', async () => {
  const engine = new SequentialSchedule({ clock: () => 35*60000, lease: async () => true,
    save: async () => {}, handlers: {
      fast: { maxUnitMs:100,step:async()=>({status:'done'}) },
      main: { maxUnitMs:100,step:async()=>({status:'done'}) },
    } });
  assert.equal((await engine.tick()).task,'fast');
  assert.equal((await engine.tick()).task,'main');
});

test('a due priority cycle preempts a long MAIN unit, then MAIN resumes after the priority checkpoint completes',async()=>{
  const ran=[];const state=freshScheduleState();state.frame={cycle:0,phase:2,spentMs:0};
  const engine=new SequentialSchedule({state,clock:()=>4*60000,lease:async()=>true,save:async()=>{},handlers:{
    priority:{maxUnitMs:100,step:async()=>{ran.push('priority');return{status:'done',checkpoint:{cycle:0,lagMs:0}};}},
    main:{maxUnitMs:100,step:async()=>{ran.push('main');return{status:'progress',checkpoint:{cursor:1,total:10}};}},
  }});
  assert.equal((await engine.tick()).task,'priority');
  assert.equal((await engine.tick()).task,'main');
  assert.deepEqual(ran,['priority','main']);
});

test('unfinished priority rolls into a missed new cycle with its cursors intact',()=>{
  const state=freshScheduleState();const first=prepareJob(state,'priority',0);first.checkpoint={cycle:0,phase:'roulette',roulette:{cycle:0,cursor:73,done:false},weekend:{cursor:11}};
  const next=prepareJob(state,'priority',3*CYCLE_MS);
  assert.equal(next.id,3);assert.equal(next.done,false);assert.equal(next.checkpoint.roulette.cursor,73);assert.equal(next.checkpoint.weekend.cursor,11);
  assert.equal(state.missedPriority,3);
});

test('priority cap with less than one max unit remaining cannot deadlock lower phases',async()=>{
  const state=freshScheduleState();state.frame={cycle:0,phase:2,spentMs:0,prioritySpentMs:PRIORITY_MAX_CYCLE_MS-10000};const ran=[];
  const engine=new SequentialSchedule({state,clock:()=>5*60000,lease:async()=>true,save:async()=>{},handlers:{
    priority:{maxUnitMs:45000,step:async()=>{ran.push('priority');return{status:'progress'};}},
    main:{maxUnitMs:100,step:async()=>{ran.push('main');return{status:'progress',checkpoint:{cursor:1,total:2}};}},
  }});
  assert.equal((await engine.tick()).task,'main');assert.deepEqual(ran,['main']);
});

test('completed main is counted once; fast completion does not complete main', async () => {
  const engine = new SequentialSchedule({ clock: () => 16 * 60000, lease: async () => true,
    save: async () => {}, handlers: { main: { maxUnitMs: 100, step: async () => ({ status: 'done' }) } } });
  await engine.tick();
  await engine.tick();
  assert.equal(engine.state.completedMain, 1);
});

test('an empty maintenance queue advances to reserve and retries later', async () => {
  const calls = [];
  const state=freshScheduleState();state.frame={cycle:0,phase:4,spentMs:0};
  const engine = new SequentialSchedule({ state,clock: () => 28 * 60000, lease: async () => true,
    save: async () => {}, handlers: {
      maintenance: { maxUnitMs: 100, step: async () => { calls.push('maintenance'); return { status: 'empty' }; } },
      main: { maxUnitMs: 100, step: async () => { calls.push('main'); return { status: 'progress', checkpoint: 1 }; } },
    } });
  await engine.tick();
  await engine.tick();
  assert.deepEqual(calls, ['maintenance', 'main', 'main']);
});

// ── Daily-main guarantee: mainAtRisk + tail-yields-to-main (guaranteeDailyMain) ──────────────
const MINMS = 60000;
// A tail-slot clock (cycle 12, minute 50) with an at-risk main pass started 23h earlier.
const TAIL_CLOCK = 1467 * MINMS;           // 24h + minute 27 (tail slot)
const FAST_CLOCK = 1442 * MINMS;           // 24h + minute 2 (fast slot)
function atRiskMainJob() {
  return { id: 0, planDate: '2026-09-20', checkpoint: { cursor: 100, total: 100000, errors: 0, wave: 43 },
    done: false, startedAt: 110 * MINMS, completedAt: null, retryAt: 0, activeMs: 60000 };
}
function recordingHandlers(ran) {
  return {
    fast: { maxUnitMs: 100, step: async () => { ran.push('fast'); return { status: 'progress', checkpoint: { cursor: 1, total: 400 } }; } },
    main: { maxUnitMs: 100, step: async () => { ran.push('main'); return { status: 'progress', checkpoint: { cursor: 200, total: 100000, wave: 43 } }; } },
    tail: { maxUnitMs: 100, step: async () => { ran.push('tail'); return { status: 'progress', checkpoint: { cursor: 501, total: 900000 } }; } },
  };
}

test('mainAtRisk: false without a job, when done, or before a measured pace; true only when behind', () => {
  assert.equal(mainAtRisk({ jobs: {} }, TAIL_CLOCK), false);
  assert.equal(mainAtRisk({ jobs: { main: { done: true, startedAt: 0, checkpoint: { cursor: 1, total: 9 } } } }, TAIL_CLOCK), false);
  // job exists but no committed cell yet → cannot judge → false (never fabricate risk)
  assert.equal(mainAtRisk({ jobs: { main: { done: false, startedAt: 110 * MINMS, checkpoint: { cursor: 0, total: 100000 } } } }, TAIL_CLOCK), false);
  // behind: 100/100000 done, 23h elapsed, 1h to the 24h deadline → at risk
  assert.equal(mainAtRisk({ jobs: { main: atRiskMainJob() } }, TAIL_CLOCK), true);
  // comfortably ahead: 90/100 done in 1h, 23h left → not at risk
  assert.equal(mainAtRisk({ jobs: { main: { done: false, startedAt: TAIL_CLOCK - 60 * MINMS, checkpoint: { cursor: 90, total: 100 } } } }, TAIL_CLOCK), false);
  // past the 24h deadline with work left → at risk (rush)
  assert.equal(mainAtRisk({ jobs: { main: { done: false, startedAt: TAIL_CLOCK - 25 * 60 * MINMS, checkpoint: { cursor: 10, total: 100 } } } }, TAIL_CLOCK), true);
});

test('tail slot YIELDS to main when the daily pass is at risk and the guarantee is on', async () => {
  const state = freshScheduleState(); state.jobs.main = atRiskMainJob();
  state.jobs.tail = { id: 0, planDate: '2026-09-20', checkpoint: { cursor: 500, total: 900000 }, done: false, startedAt: 0, completedAt: null, retryAt: 0, activeMs: 0 };
  state.frame = { cycle: 48, phase: 3, spentMs: 0 };   // already at the tail slot
  const ran = [];
  const engine = new SequentialSchedule({ state, clock: () => TAIL_CLOCK, lease: async () => true, save: async () => {}, guaranteeDailyMain: true, handlers: recordingHandlers(ran) });
  const r = await engine.tick();
  assert.equal(r.task, 'main');
  assert.deepEqual(ran, ['main']);
  // tail's own cursor is untouched — it is not reset, it resumes later
  assert.equal(engine.state.jobs.tail.checkpoint.cursor, 500);
  // no new main was started over the unfinished one
  assert.equal(engine.state.jobs.main.startedAt, 110 * MINMS);
  assert.equal(engine.state.completedMain, 0);
});

test('tail slot runs TAIL normally when the guarantee is OFF, even if main is behind (no regression)', async () => {
  const state = freshScheduleState(); state.jobs.main = atRiskMainJob();
  state.frame = { cycle: 48, phase: 3, spentMs: 0 };
  const ran = [];
  const engine = new SequentialSchedule({ state, clock: () => TAIL_CLOCK, lease: async () => true, save: async () => {}, guaranteeDailyMain: false, handlers: recordingHandlers(ran) });
  const r = await engine.tick();
  assert.equal(r.task, 'tail');
  assert.deepEqual(ran, ['tail']);
});

test('tail slot runs TAIL when the guarantee is on but main is NOT at risk', async () => {
  const state = freshScheduleState();
  state.jobs.main = { id: 0, planDate: '2026-09-20', checkpoint: { cursor: 90, total: 100, errors: 0 }, done: false, startedAt: TAIL_CLOCK - 60 * MINMS, completedAt: null, retryAt: 0, activeMs: 60000 };
  state.frame = { cycle: 48, phase: 3, spentMs: 0 };
  const ran = [];
  const engine = new SequentialSchedule({ state, clock: () => TAIL_CLOCK, lease: async () => true, save: async () => {}, guaranteeDailyMain: true, handlers: recordingHandlers(ran) });
  const r = await engine.tick();
  assert.equal(r.task, 'tail');
});

test('fast is never starved: its own slot still runs fast even while main is at risk', async () => {
  const state = freshScheduleState(); state.jobs.main = atRiskMainJob();
  const ran = [];
  const engine = new SequentialSchedule({ state, clock: () => FAST_CLOCK, lease: async () => true, save: async () => {}, guaranteeDailyMain: true, handlers: recordingHandlers(ran) });
  const r = await engine.tick();
  assert.equal(r.task, 'fast');
});

test('completed main is still counted once with the guarantee on (snapshot/counting unchanged)', async () => {
  const engine = new SequentialSchedule({ clock: () => 16 * MINMS, lease: async () => true, save: async () => {},
    guaranteeDailyMain: true, handlers: { main: { maxUnitMs: 100, step: async () => ({ status: 'done', checkpoint: { cursor: 5, total: 5, wave: 43 } }) } } });
  await engine.tick();
  await engine.tick();
  assert.equal(engine.state.completedMain, 1);
});

test('nextPriorityDueAt is the exact start of the NEXT 30-minute cycle, never the current one', () => {
  assert.equal(nextPriorityDueAt(0), CYCLE_MS);
  assert.equal(nextPriorityDueAt(CYCLE_MS - 1), CYCLE_MS);
  assert.equal(nextPriorityDueAt(CYCLE_MS), 2 * CYCLE_MS); // exactly on a boundary counts as already in that cycle
  assert.equal(nextPriorityDueAt(CYCLE_MS + 1), 2 * CYCLE_MS);
});

test('offCycleMainBudget never crosses into the safety margin before the next due cycle', () => {
  // 10 minutes into a cycle, 20 minutes of runway left before the next due cycle.
  const instant = 10 * MINMS;
  const stop = offCycleMainBudget(instant, { safetyMarginMs: 5 * MINMS, maxSessionMs: 3 * MINMS });
  assert.equal(stop, instant + 3 * MINMS); // maxSessionMs is the binding constraint here
  assert.ok(nextPriorityDueAt(instant) - stop >= 5 * MINMS);
});

test('offCycleMainBudget is bounded by the safety margin, not just maxSessionMs, when the cycle is nearly over', () => {
  // 27 minutes into a cycle: only 3 minutes of runway before the next due cycle.
  const instant = 27 * MINMS;
  const stop = offCycleMainBudget(instant, { safetyMarginMs: 90_000, maxSessionMs: 5 * MINMS });
  assert.equal(stop, nextPriorityDueAt(instant) - 90_000);
  assert.ok(stop - instant < 2 * MINMS, 'runway is capped well under maxSessionMs by the margin');
});

test('offCycleMainBudget fails closed (null = do no work) once inside the safety margin — never delays priority', () => {
  const instant = 29 * MINMS; // 1 minute of runway, less than a 90s margin
  assert.equal(offCycleMainBudget(instant, { safetyMarginMs: 90_000, maxSessionMs: 3 * MINMS }), null);
  // A margin as wide as the whole cycle: everywhere inside the cycle is "too close" — always null.
  assert.equal(offCycleMainBudget(1 * MINMS, { safetyMarginMs: CYCLE_MS, maxSessionMs: 3 * MINMS }), null);
});

test('offCycleMainBudget rejects invalid inputs instead of silently defaulting', () => {
  assert.throws(() => offCycleMainBudget(-1, { safetyMarginMs: 1000, maxSessionMs: 1000 }), /Invalid clock/);
  assert.throws(() => offCycleMainBudget(0, { safetyMarginMs: -1, maxSessionMs: 1000 }), /Invalid off-cycle budget/);
  assert.throws(() => offCycleMainBudget(0, { safetyMarginMs: 0, maxSessionMs: 0 }), /Invalid off-cycle budget/);
});

test('an off-cycle engine with only fast/main/tail handlers never touches priority: no cursor reset, no lag', async () => {
  // Simulates a mid-cycle (priority-not-due) trigger: the SAME engine machinery, just without a
  // priority handler registered, resuming main from a non-zero saved cursor.
  const state = freshScheduleState();
  state.jobs.main = { id: 0, planDate: '2026-09-24', checkpoint: { cursor: 100, total: 23952, wave: 43 }, done: false, startedAt: 0, completedAt: null, retryAt: 0, activeMs: 0 };
  const stop = offCycleMainBudget(10 * MINMS, { safetyMarginMs: 5 * MINMS, maxSessionMs: 3 * MINMS });
  const engine = new SequentialSchedule({
    state, clock: () => 10 * MINMS, lease: async () => true, save: async (s) => { state.jobs = s.jobs; state.frame = s.frame; }, stopAt: stop,
    handlers: { main: { maxUnitMs: 1000, step: async ({ job }) => ({ status: 'progress', checkpoint: { ...job.checkpoint, cursor: job.checkpoint.cursor + 1 } }) } },
  });
  const r = await engine.tick();
  assert.equal(r.task, 'main');
  assert.equal(r.status, 'progress');
  assert.equal(engine.state.jobs.main.checkpoint.cursor, 101); // resumed from 100, not reset to 0
  // The engine still tracks a priority job record internally (needed to compute priorityDue), but
  // with no handler registered no work is ever attempted on it: checkpoint stays null, never done.
  assert.equal(engine.state.jobs.priority.checkpoint, null);
  assert.equal(engine.state.jobs.priority.done, false);
});

test('an off-cycle engine cannot busy-loop past its own stopAt: it reports idle once budget is exhausted', async () => {
  const state = freshScheduleState();
  state.jobs.main = { id: 0, planDate: '2026-09-24', checkpoint: { cursor: 0, total: 5, wave: 43 }, done: false, startedAt: 0, completedAt: null, retryAt: 0, activeMs: 0 };
  let clock = 10 * MINMS;
  const stop = clock + 500; // a tiny 500ms budget
  const engine = new SequentialSchedule({
    state, clock: () => clock, lease: async () => true, save: async (s) => { state.jobs = s.jobs; state.frame = s.frame; }, stopAt: stop,
    handlers: { main: { maxUnitMs: 1000, step: async ({ job }) => ({ status: 'progress', checkpoint: { ...job.checkpoint, cursor: job.checkpoint.cursor + 1 } }) } },
  });
  const r = await engine.tick(); // a 1000ms unit cannot fit in a 500ms budget
  assert.equal(r.status, 'idle');
  assert.equal(engine.state.jobs.main.checkpoint.cursor, 0); // nothing was attempted, nothing to roll back
});

test('off-cycle MAIN never silently claims it finished on time when the provider is slower than estimated: it fails loud instead', async () => {
  // A unit whose maxUnitMs estimate fits the remaining budget is admitted, but the provider turns
  // out to be slower than estimated and the real wall-clock time crosses stopAt mid-unit. The
  // engine must never silently return as if the budget was respected — it raises, so a caller
  // (run-collection.mjs's off-cycle branch) can never mistake a slow overrun for a clean stop.
  const state = freshScheduleState();
  state.jobs.main = { id: 0, planDate: '2026-09-24', checkpoint: { cursor: 0, total: 5, wave: 43 }, done: false, startedAt: 0, completedAt: null, retryAt: 0, activeMs: 0 };
  let clock = 10 * MINMS;
  const stop = offCycleMainBudget(clock, { safetyMarginMs: 90_000, maxSessionMs: 2 * MINMS }); // a normal, safely-margined off-cycle budget
  const engine = new SequentialSchedule({
    state, clock: () => clock, lease: async () => true, save: async (s) => { state.jobs = s.jobs; state.frame = s.frame; }, stopAt: stop,
    handlers: { main: { maxUnitMs: 30_000, step: async ({ job }) => { clock += 5 * MINMS; /* simulated slow provider, way past its own estimate */
      return { status: 'progress', checkpoint: { ...job.checkpoint, cursor: job.checkpoint.cursor + 1 } }; } } },
  });
  await assert.rejects(() => engine.tick(), /exceeded its slot/);
});

test('runBoundedMainAdvance keeps calling bounded ticks while runway remains, one main unit per productive tick', async () => {
  const state = freshScheduleState();
  state.jobs.main = { id: 0, planDate: '2026-09-24', checkpoint: { cursor: 0, total: 100, wave: 43 }, done: false, startedAt: 0, completedAt: null, retryAt: 0, activeMs: 0 };
  let clock = 0, stepCalls = 0;
  const engine = new SequentialSchedule({
    state, clock: () => clock, lease: async () => true, save: async (s) => { state.jobs = s.jobs; state.frame = s.frame; },
    stopAt: 6 * MINMS, // enough runway for several 75s-work/90s-admission units, not the whole plan
    handlers: { main: { maxUnitMs: 90_000, step: async ({ job }) => { stepCalls++; clock += 75_000;
      return { status: 'progress', checkpoint: { ...job.checkpoint, cursor: job.checkpoint.cursor + 1 } }; } } },
  });
  const { ticks, lastStatus } = await runBoundedMainAdvance({ engine, stopAt: 6 * MINMS, clock: () => clock });
  // Real units keep landing (matching cursor/stepCalls) until the scheduler's own
  // LOWER_PHASE_RESERVE_MS guard makes the next unit no longer fit before stopAt; that last
  // recheck costs one more (non-productive) tick() call, which is exactly what a caller must be
  // able to tell apart from a wasted spin — lastStatus surfaces it as 'idle'.
  assert.ok(stepCalls >= 3, `expected several bounded main units to run, got ${stepCalls}`);
  assert.equal(engine.state.jobs.main.checkpoint.cursor, stepCalls, 'one cell of progress per productive tick, matching the mocked adapter');
  assert.equal(ticks, stepCalls + 1, 'exactly one extra tick() call detects the deadline and reports idle — no busy-loop beyond that');
  assert.equal(lastStatus, 'idle', 'stops because the next unit no longer fits before stopAt, reported cleanly as idle');
});

test('runBoundedMainAdvance stops immediately and cleanly on true idle — no busy-loop', async () => {
  let tickCalls = 0;
  const engine = { tick: async () => { tickCalls++; return { status: 'idle' }; } };
  const { ticks, lastStatus } = await runBoundedMainAdvance({ engine, stopAt: 10 * MINMS, clock: () => 0 });
  assert.equal(ticks, 1, 'idle must stop the loop on the very first tick, not spin waiting for more work');
  assert.equal(tickCalls, 1);
  assert.equal(lastStatus, 'idle');
});

test('runBoundedMainAdvance never calls tick() once runway is exhausted (rechecks the hard deadline before every unit)', async () => {
  let tickCalls = 0;
  const engine = { tick: async () => { tickCalls++; return { status: 'progress' }; } };
  const { ticks } = await runBoundedMainAdvance({ engine, stopAt: 0, clock: () => 0 }); // zero runway from the start
  assert.equal(ticks, 0);
  assert.equal(tickCalls, 0, 'no unit may be attempted once stopAt has already been reached');
});

test('runBoundedMainAdvance has a hard iteration ceiling so a misbehaving engine can never spin forever', async () => {
  let tickCalls = 0;
  const engine = { tick: async () => { tickCalls++; return { status: 'progress' }; } }; // never advances the clock
  const { ticks } = await runBoundedMainAdvance({ engine, stopAt: 10 * MINMS, clock: () => 0, maxTicks: 25 });
  assert.equal(ticks, 25);
  assert.equal(tickCalls, 25);
});

// Regression coverage for the production traces that showed a genuinely-idle-looking off-cycle
// session had, in fact, made or could still make real MAIN progress:
//   21:10  ticks=1 providerRequests=0   mainCursor unchanged  lastStatus='idle'
//   21:15  ticks=1 providerRequests=266 mainCursor 2371→2432  lastStatus='idle'
// Root cause: SequentialSchedule.tick() only `return`s early on 'progress'/'done'. On 'empty' or
// 'yield' it advances the persisted frame phase and keeps sweeping tail/maintenance/reserve WITHIN
// THE SAME tick() call, so a MAIN unit that ran for most of its allotted deadline (21:15's 266
// requests / 61 cells) and then yielded — or a MAIN job still on its 60s post-yield `retryAt`
// cooldown from an earlier trigger (21:10, skipped before ever calling adapter.step) — both
// surface as a bare top-level 'idle'. The pre-fix runBoundedMainAdvance stopped the whole off-cycle
// process on that first 'idle', discarding any remaining `stopAt` runway and forcing the next
// 5-minute cron trigger to pay full session startup before MAIN could resume.
test('off-cycle idle after a MAIN cooldown (the 21:10 trace: 0 requests, cursor unchanged) waits out the retry instead of ending the session',async()=>{
  const state=freshScheduleState();
  // main.retryAt is 30s in the future — as SequentialSchedule.tick() itself leaves it right after a
  // yield/empty result (retryAt = that tick's clock() + 60_000); this trigger's own claim/session
  // start landed 30s into that cooldown, well before minRunwayMs is even relevant.
  state.jobs.main={id:0,planDate:'2026-09-24',checkpoint:{cursor:2371,total:5000,wave:43},done:false,startedAt:0,completedAt:null,retryAt:30_000,activeMs:0};
  let clock=0,stepCalls=0,sleptMs=null;
  const engine=new SequentialSchedule({
    state,clock:()=>clock,lease:async()=>true,save:async s=>{state.jobs=s.jobs;state.frame=s.frame;},
    stopAt:20*MINMS, // ~20 minutes of real stopAt runway still available — nowhere near exhausted
    handlers:{main:{maxUnitMs:90_000,step:async({job})=>{stepCalls++;clock+=75_000;
      return{status:'progress',checkpoint:{...job.checkpoint,cursor:job.checkpoint.cursor+1}};}}},
  });
  const sleep=async ms=>{sleptMs=ms;clock+=ms;};
  const{ticks,lastStatus}=await runBoundedMainAdvance({engine,stopAt:20*MINMS,clock:()=>clock,sleep});
  assert.ok(sleptMs!==null&&sleptMs<=60_000,'waits out MAIN\'s own bounded (<=60s) retryAt cooldown, no busy-loop');
  assert.ok(stepCalls>=1,'after the cooldown, MAIN actually resumes and makes real progress in this same session');
  assert.ok(state.jobs.main.checkpoint.cursor>2371,'the durable cursor advances instead of the session ending at cursor unchanged');
  assert.ok(ticks>1,'more than the single wasted idle tick from before the fix');
});

test('off-cycle idle right after a real MAIN burst (the 21:15 trace: 266 requests, cursor +61) stops cleanly once too little runway remains',async()=>{
  const state=freshScheduleState();
  state.jobs.main={id:0,planDate:'2026-09-24',checkpoint:{cursor:2371,total:5000,wave:43},done:false,startedAt:0,completedAt:null,retryAt:0,activeMs:0};
  let clock=0,slept=false;
  const engine=new SequentialSchedule({
    state,clock:()=>clock,lease:async()=>true,save:async s=>{state.jobs=s.jobs;state.frame=s.frame;},
    stopAt:80_000, // barely any runway left, matching a MAIN burst that already consumed the window
    handlers:{main:{maxUnitMs:75_000,step:async({job})=>{clock+=75_000;
      // Mirrors collection-adapters.mjs's provider-throttle CollectionYield: the unit ran to (near)
      // its own deadline doing real work, then yielded — SequentialSchedule.tick() sets retryAt.
      return{status:'yield',checkpoint:{...job.checkpoint,cursor:job.checkpoint.cursor+61}};}}},
  });
  const sleep=async ms=>{slept=true;clock+=ms;};
  const{lastStatus}=await runBoundedMainAdvance({engine,stopAt:80_000,clock:()=>clock,sleep});
  assert.equal(lastStatus,'idle');
  assert.equal(state.jobs.main.checkpoint.cursor,2432,'the real progress from this trigger is preserved');
  assert.equal(slept,false,'retryAt (clock()+60s) would land past stopAt minus minRunwayMs — must not wait, must stop cleanly');
});

test('off-cycle never waits past stopAt: a retryAt that would leave less than minRunwayMs stops immediately instead of oversleeping',async()=>{
  const state=freshScheduleState();
  state.jobs.main={id:0,planDate:'2026-09-24',checkpoint:{cursor:10,total:5000,wave:43},done:false,startedAt:0,completedAt:null,retryAt:57_000,activeMs:0};
  let clock=0,tickCalls=0;
  const engine={state,tick:async()=>{tickCalls++;return{status:'idle'};}};
  const{ticks,lastStatus}=await runBoundedMainAdvance({engine,stopAt:60_000,clock:()=>clock,minRunwayMs:5000,
    sleep:async()=>{throw new Error('must never sleep when the wait would cross stopAt - minRunwayMs');}});
  assert.equal(tickCalls,1);assert.equal(ticks,1);assert.equal(lastStatus,'idle');
});

test('off-cycle does not retry-wait when MAIN is already done, has no pending retry, or the cooldown already elapsed (never a busy-loop)',async()=>{
  const casesDone={id:0,planDate:'x',checkpoint:{cursor:5000,total:5000},done:true,retryAt:0,activeMs:0};
  const engineDone={state:{jobs:{main:casesDone}},tick:async()=>({status:'idle'})};
  const r1=await runBoundedMainAdvance({engine:engineDone,stopAt:10*MINMS,clock:()=>0,sleep:async()=>{throw new Error('no sleep: done');}});
  assert.equal(r1.ticks,1);

  const noRetry={id:0,planDate:'x',checkpoint:{cursor:10,total:5000},done:false,retryAt:0,activeMs:0};
  const engineNoRetry={state:{jobs:{main:noRetry}},tick:async()=>({status:'idle'})};
  const r2=await runBoundedMainAdvance({engine:engineNoRetry,stopAt:10*MINMS,clock:()=>0,sleep:async()=>{throw new Error('no sleep: no pending retry');}});
  assert.equal(r2.ticks,1);

  const staleRetry={id:0,planDate:'x',checkpoint:{cursor:10,total:5000},done:false,retryAt:100,activeMs:0};
  const engineStale={state:{jobs:{main:staleRetry}},tick:async()=>({status:'idle'})};
  const r3=await runBoundedMainAdvance({engine:engineStale,stopAt:10*MINMS,clock:()=>1000,sleep:async()=>{throw new Error('no sleep: retryAt already elapsed');}});
  assert.equal(r3.ticks,1);
});

// The next four tests simulate separate off-cycle GitHub Actions invocations (each a fresh
// process, fresh SequentialSchedule instance) that only share the durably-saved checkpoint — the
// exact shape of successive real 5-minute-trigger sessions. `durable` stands in for the row
// CollectionStore reads/writes; each "trigger" builds its engine from a structuredClone of it, so
// nothing but the saved checkpoint carries over, the same as two separate GH Actions jobs would.
function offCycleSession({ durable, clockStart, budgetMs, mainStep }) {
  let clock = clockStart;
  const state = structuredClone(durable.state);
  const engine = new SequentialSchedule({
    state, clock: () => clock, lease: async () => true,
    save: async s => { durable.state = structuredClone(s); }, stopAt: clockStart + budgetMs,
    handlers: { main: { maxUnitMs: 90_000, step: async args => { clock += 75_000; return mainStep(args); } } },
  });
  return runBoundedMainAdvance({ engine, stopAt: clockStart + budgetMs, clock: () => clock }).then(r => ({ ...r, engine }));
}

test('successive off-cycle triggers accumulate MAIN progress across separate sessions without resetting the checkpoint', async () => {
  const durable = { state: freshScheduleState() };
  durable.state.jobs.main = { id: 0, planDate: '2026-09-24', checkpoint: { cursor: 0, errors: 0, total: 50, wave: 43 }, done: false, startedAt: 0, completedAt: null, retryAt: 0, activeMs: 0 };
  const step = ({ job }) => ({ status: 'progress', checkpoint: { ...job.checkpoint, cursor: job.checkpoint.cursor + 1 } });

  const first = await offCycleSession({ durable, clockStart: 10 * MINMS, budgetMs: 6 * MINMS, mainStep: step });
  const cursorAfterFirst = durable.state.jobs.main.checkpoint.cursor;
  assert.ok(cursorAfterFirst > 0, 'first trigger made real progress');
  assert.equal(first.lastStatus, 'idle');

  // A second, independently-built session (new engine, no shared object identity with the first)
  // resumes from the persisted checkpoint rather than restarting at 0.
  const second = await offCycleSession({ durable, clockStart: 40 * MINMS, budgetMs: 6 * MINMS, mainStep: step });
  assert.ok(durable.state.jobs.main.checkpoint.cursor > cursorAfterFirst, 'second trigger resumed and advanced further, not reset');
  assert.equal(second.lastStatus, 'idle');
  // Priority was never offered a handler in either session — untouched across both triggers.
  assert.equal(durable.state.jobs.priority.checkpoint, null);
  assert.equal(durable.state.jobs.priority.done, false);
});

test('soft per-cell errors from the main adapter accumulate in the persisted checkpoint across successive off-cycle triggers without halting progress', async () => {
  const durable = { state: freshScheduleState() };
  durable.state.jobs.main = { id: 0, planDate: '2026-09-24', checkpoint: { cursor: 0, errors: 0, total: 50, wave: 43 }, done: false, startedAt: 0, completedAt: null, retryAt: 0, activeMs: 0 };
  // Every other cell reports a provider probe failure — the real main adapter's soft-error shape
  // (cp.errors increments, cursor still advances, status stays 'progress' — see
  // collection-adapters.mjs's directResult/anyResult error accounting).
  const flakyStep = ({ job }) => {
    const failed = job.checkpoint.cursor % 2 === 1;
    return { status: 'progress', checkpoint: { ...job.checkpoint, cursor: job.checkpoint.cursor + 1, errors: job.checkpoint.errors + (failed ? 1 : 0) } };
  };

  await offCycleSession({ durable, clockStart: 10 * MINMS, budgetMs: 6 * MINMS, mainStep: flakyStep });
  const afterFirst = durable.state.jobs.main.checkpoint;
  assert.ok(afterFirst.cursor > 0 && afterFirst.errors > 0, 'errors were recorded without stalling the cursor');
  assert.equal(afterFirst.errors, Math.floor(afterFirst.cursor / 2), 'error count matches the flaky pattern exactly, no double-count or drop');

  await offCycleSession({ durable, clockStart: 40 * MINMS, budgetMs: 6 * MINMS, mainStep: flakyStep });
  const afterSecond = durable.state.jobs.main.checkpoint;
  assert.ok(afterSecond.cursor > afterFirst.cursor, 'a second session keeps making progress despite earlier errors');
  assert.ok(afterSecond.errors > afterFirst.errors, 'the error count is cumulative across sessions, not reset');
});

test('a hard adapter failure mid-unit propagates out of an off-cycle session instead of being swallowed, and the last durably-saved checkpoint is left intact', async () => {
  const durable = { state: freshScheduleState() };
  durable.state.jobs.main = { id: 0, planDate: '2026-09-24', checkpoint: { cursor: 3, errors: 0, total: 50, wave: 43 }, done: false, startedAt: 0, completedAt: null, retryAt: 0, activeMs: 0 };
  const checkpointBefore = structuredClone(durable.state.jobs.main.checkpoint);
  let clock = 10 * MINMS;
  const state = structuredClone(durable.state);
  const engine = new SequentialSchedule({
    state, clock: () => clock, lease: async () => true, save: async s => { durable.state = structuredClone(s); },
    stopAt: clock + 6 * MINMS,
    handlers: { main: { maxUnitMs: 90_000, step: async () => { clock += 75_000; throw new Error('provider write was not acknowledged'); } } },
  });
  await assert.rejects(
    () => runBoundedMainAdvance({ engine, stopAt: clock + 6 * MINMS, clock: () => clock }),
    /provider write was not acknowledged/,
    'a genuine adapter failure must surface to the caller (run-collection.mjs\'s top-level catch), not be treated as a clean stop',
  );
  // The failed unit's pre-attempt state was durably saved (SequentialSchedule.tick() persists
  // BEFORE calling adapter.step); the checkpoint itself is exactly what it was before the failed
  // unit — no partial/corrupt forward write from the unit that threw.
  assert.deepEqual(durable.state.jobs.main.checkpoint, checkpointBefore);
});
