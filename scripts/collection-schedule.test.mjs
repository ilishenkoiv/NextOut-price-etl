import test from 'node:test';
import assert from 'node:assert/strict';
import { SequentialSchedule, freshScheduleState, prepareJob, slotAt, SLOTS, CYCLE_MS, MAIN_CYCLE_MS, mainAtRisk } from './collection-schedule.mjs';

test('a cycle has the agreed budgets and no overlaps or holes', () => {
  let end = 0;
  const budgets = {};
  for (const slot of SLOTS) {
    assert.equal(slot.from, end);
    end = slot.to;
    budgets[slot.task] = (budgets[slot.task] ?? 0) + slot.to - slot.from;
  }
  assert.equal(end, 120);
  assert.deepEqual(budgets, { fast: 10, maintenance: 10, main: 55, tail: 35, reserve: 10 });
  assert.equal(slotAt(10 * 60000).task, 'maintenance');
  assert.equal(slotAt(CYCLE_MS).task, 'fast');
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
  assert.equal(b.cycle-a.cycle,1);
});

test('fast checkpoints expire per two-hour cycle, not per day', () => {
  const state = freshScheduleState();
  const first = prepareJob(state, 'fast', 0);
  first.done = true;
  assert.equal(prepareJob(state, 'fast', 60000).done, true);
  assert.equal(prepareJob(state, 'fast', CYCLE_MS).done, false);
  prepareJob(state, 'fast', 2 * CYCLE_MS);
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

test('completed main is counted once; fast completion does not complete main', async () => {
  const engine = new SequentialSchedule({ clock: () => 16 * 60000, lease: async () => true,
    save: async () => {}, handlers: { main: { maxUnitMs: 100, step: async () => ({ status: 'done' }) } } });
  await engine.tick();
  await engine.tick();
  assert.equal(engine.state.completedMain, 1);
});

test('an empty maintenance queue lends its slot to main and retries later', async () => {
  const calls = [];
  const engine = new SequentialSchedule({ clock: () => 11 * 60000, lease: async () => true,
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
const TAIL_CLOCK = 1490 * MINMS;           // 1490 min → cycle 12, minute 50 (tail slot)
const FAST_CLOCK = 1445 * MINMS;           // 1445 min → cycle 12, minute 5  (fast slot)
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
  state.frame = { cycle: 12, phase: 3, spentMs: 0 };   // already at the tail slot (SLOTS[3] = 45–65)
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
  state.frame = { cycle: 12, phase: 3, spentMs: 0 };   // already at the tail slot
  const ran = [];
  const engine = new SequentialSchedule({ state, clock: () => TAIL_CLOCK, lease: async () => true, save: async () => {}, guaranteeDailyMain: false, handlers: recordingHandlers(ran) });
  const r = await engine.tick();
  assert.equal(r.task, 'tail');
  assert.deepEqual(ran, ['tail']);
});

test('tail slot runs TAIL when the guarantee is on but main is NOT at risk', async () => {
  const state = freshScheduleState();
  state.jobs.main = { id: 0, planDate: '2026-09-20', checkpoint: { cursor: 90, total: 100, errors: 0 }, done: false, startedAt: TAIL_CLOCK - 60 * MINMS, completedAt: null, retryAt: 0, activeMs: 60000 };
  state.frame = { cycle: 12, phase: 3, spentMs: 0 };   // already at the tail slot
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
