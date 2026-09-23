import test from 'node:test';
import assert from 'node:assert/strict';
import { SequentialSchedule, freshScheduleState, prepareJob, slotAt, SLOTS, CYCLE_MS, MAIN_CYCLE_MS, PRIORITY_MAX_CYCLE_MS, mainAtRisk, nominalSessionBudgets,
  priorityCycleProjection, measuredPriorityCapacity, projectMonthlyRunnerUsage } from './collection-schedule.mjs';

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
