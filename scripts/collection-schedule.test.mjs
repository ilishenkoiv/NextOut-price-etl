import test from 'node:test';
import assert from 'node:assert/strict';
import { SequentialSchedule, freshScheduleState, prepareJob, slotAt, SLOTS, CYCLE_MS } from './collection-schedule.mjs';

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
