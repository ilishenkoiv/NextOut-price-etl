// Integration proofs for the combined patch (daily-main priority + safe Supabase retry). These
// assert that with BOTH patches applied, main-at-risk only borrows tail slots — fast, maintenance,
// reserve, roulette recheck and the feedback audit all keep working and stay strictly sequential —
// and that the retry never turns a lost/transient write into a false success or a lost checkpoint.
//
// Retry-safety fundamentals (transient retried, permanent surfaced, deadline-bounded, lease per
// attempt, cursor only after confirmed commit, claim never retried) are proven in
// collection-retry.test.mjs; the daily-main capacity model in collection-daily-guarantee.test.mjs.
// Here we prove the cross-cutting interactions the merge must preserve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { SequentialSchedule, freshScheduleState, CYCLE_MS, prepareJob } from './collection-schedule.mjs';
import { createAdapters } from './collection-adapters.mjs';
import { simulate, reserveOf } from './collection-daily-sim.mjs';

const MINMS = 60000, MAIN_CYCLE = 24 * 60 * MINMS;
const CLOCK = 100000;                 // fixed sim clock; today = 1970-01-01
const TODAY = new Date(CLOCK).toISOString().slice(0, 10);
const DEADLINE = 5_000_000;           // far from CLOCK → no boundary yield

// ── Maintenance mock (name-dispatching PostgREST-like db) ──────────────────────────────────────
function makeDb(script, log) {
  const take = (map, key) => { const a = map?.[key]; if (!a || !a.length) return { data: [], error: null }; return a.length > 1 ? a.shift() : a[0]; };
  const fromBuilder = (t) => new Proxy(function () {}, { get: (_x, k) => {
    if (k === 'then') { const p = Promise.resolve().then(() => take(script.from, t)); return p.then.bind(p); }
    return () => fromBuilder(t);
  }});
  const rpcThenable = (n) => { const p = Promise.resolve().then(() => take(script.rpc, n)); return { then: p.then.bind(p) }; };
  return {
    from: (t) => { log.push('from:' + t); return fromBuilder(t); },
    rpc: (n) => { log.push('rpc:' + n); return rpcThenable(n); },
    storage: { from: () => ({
      list: () => { log.push('list'); const p = Promise.resolve().then(() => ({ data: [], error: null })); return { then: p.then.bind(p) }; },
      upload: () => { log.push('upload'); const p = Promise.resolve().then(() => ({ data: {}, error: null })); return { then: p.then.bind(p) }; },
      remove: () => { const p = Promise.resolve().then(() => ({ data: {}, error: null })); return { then: p.then.bind(p) }; },
    }) },
  };
}
function maintenanceAdapters({ script, log = [], lease = async () => true, provider }) {
  const planCache = new Map();
  const store = { args: () => ({ p_owner: 'o', p_token: 1 }), lease, runId: 'r',
    plan: async (k, build) => { if (!planCache.has(k)) planCache.set(k, await build()); return planCache.get(k); } };
  const db = makeDb(script, log);
  const prov = provider ?? { request: async url => {const q=new URL(url).searchParams;return { kind: 'ok', json: { success: true, data: [{
    origin:q.get('origin'),destination:q.get('destination'),departure_at:q.get('departure_at')+'T06:00:00Z',
    return_at:q.get('return_at')+'T20:00:00Z',price:111,transfers:q.get('direct')==='true'?0:1,currency:'EUR'}] } };} };
  return { adapters: createAdapters({ db, store, provider: prov, wave: 43, clock: () => CLOCK, sleep: async () => {}, random: () => 0 }), log };
}
const onlyFeedbackAndRoulette = (over = {}) => ({ cycle:1,dueAt:0,phase:'audit',auditDone:false,
  roulette:{cycle:1,cursor:0,done:false,errors:0},...over });
const cnt = (log, x) => log.filter(e => e === x).length;
const POOL = 'daily_origin_cheapest_pool';
const TICKET = { origin: 'FRA', dest: 'MAD', flight_type: 'direct', departure_at: '2027-01-10', return_at: '2027-01-17', rank: 1 };
// Scripts a working roulette turn: latest snapshot row, then the ticket page (<1000 ⇒ one page).
const rouletteScript = () => ({ from: { [POOL]: [{ data: [{ snapshot_at: 'S1' }], error: null }, { data: [TICKET], error: null }] },
  rpc: { collection_commit_roulette: [{ data: true, error: null }], collection_revive_route: [{ data: true, error: null }] } });

// ── 4. Maintenance turn 0 processes the flight_price_feedback queue ─────────────────────────────
test('4. maintenance turn 0 claims and finalizes a flight_price_feedback item', async () => {
  const script = { rpc: { claim_flight_price_audit: [{ data: [{ feedback_id: 'f1', claim_token: 't1', created_at:new Date(CLOCK-60000).toISOString(),feedback: {} }], error: null }],
    finish_flight_price_audit: [{ data: true, error: null }] } };
  const { adapters, log } = maintenanceAdapters({ script });
  // roulette already done this cycle so only turn 0 acts
  const result=await adapters.priority.step({ job: { id: 1, planDate: TODAY, startedAt: CLOCK, checkpoint: onlyFeedbackAndRoulette({ roulette: { cycle: 1, cursor: 0, done: true } }) }, deadline: DEADLINE });
  assert.equal(cnt(log, 'rpc:claim_flight_price_audit'), 1);
  assert.equal(cnt(log, 'rpc:finish_flight_price_audit'), 1);
  assert.equal(result.checkpoint.auditOldestWaitMs,60000);
});

// ── 5 + 10. Maintenance turn 1 rechecks the roulette pool by EXACT ticket, no pool rebuild ──────
test('5+10. maintenance turn 1 rechecks exact roulette tickets and never republishes the pool', async () => {
  const seen = [];
  const provider = { request: async (url) => { seen.push(url); const q=new URL(url).searchParams;return { kind: 'ok', json: { success: true, data: [{
    origin:q.get('origin'),destination:q.get('destination'),departure_at:q.get('departure_at')+'T06:00:00Z',
    return_at:q.get('return_at')+'T20:00:00Z',price:111,transfers:0,currency:'EUR'}] } };} };
  const script = { ...rouletteScript(), rpc: { ...rouletteScript().rpc, claim_flight_price_audit: [{ data: [], error: null }] } };
  const { adapters, log } = maintenanceAdapters({ script, provider });
  const r = await adapters.priority.step({ job: { id: 1, planDate: TODAY, startedAt: CLOCK, checkpoint: onlyFeedbackAndRoulette() }, deadline: DEADLINE });
  assert.equal(cnt(log, 'rpc:collection_commit_roulette'), 1, 'commits the recheck to offers');
  assert.ok(seen.some(u => u.includes('origin=FRA') && u.includes('destination=MAD') && u.includes('departure_at=2027-01-10')), 'exact ticket rechecked');
  assert.equal(cnt(log, 'upload'), 0, 'no snapshot upload');           // does not rebuild the public pool
  assert.equal(r.checkpoint.roulette.cursor, 1, 'roulette cursor advanced by one');
});

// ── 6. Roulette keeps its cursor between maintenance windows ────────────────────────────────────
test('6. roulette cursor persists across maintenance windows', async () => {
  const script = { from: { [POOL]: [{ data: [{ snapshot_at: 'S1' }], error: null }, { data: [TICKET, { ...TICKET, dest: 'BCN' }], error: null }] },
    rpc: { collection_commit_roulette: [{ data: true, error: null }], collection_revive_route: [{ data: true, error: null }], claim_flight_price_audit: [{ data: [], error: null }] } };
  const { adapters } = maintenanceAdapters({ script });
  const cp0 = onlyFeedbackAndRoulette();
  const r1 = await adapters.priority.step({ job: { id: 1, planDate: TODAY, startedAt: CLOCK, checkpoint: cp0 }, deadline: DEADLINE });
  assert.equal(r1.checkpoint.roulette.cursor, 1);
  const r2 = await adapters.priority.step({ job: { id: 1, planDate: TODAY, startedAt: CLOCK, checkpoint: r1.checkpoint }, deadline: DEADLINE });
  assert.equal(r2.checkpoint.roulette.cursor, 2, 'resumes from the persisted cursor, not from 0');
  assert.equal(r2.checkpoint.roulette.done, true, 'both tickets checked exactly once');
});

// ── 7 + 8. The feedback queue and the roulette recheck do not block each other ──────────────────
// Maintenance does ONE bounded unit per step and rotates cp.turn, so even with BOTH queues
// permanently busy the two tasks strictly alternate across steps — neither can monopolize.
test('7+8. a busy feedback queue is bounded to ten claims, then roulette runs (no starvation)', async () => {
  const script = { from: rouletteScript().from,
    rpc: { claim_flight_price_audit: [{ data: [{ feedback_id: 'f1', claim_token: 't1', feedback: {} }], error: null }],   // always busy (last repeats)
      finish_flight_price_audit: [{ data: true, error: null }], collection_commit_roulette: [{ data: true, error: null }],
      collection_revive_route: [{ data: true, error: null }] } };
  const { adapters, log } = maintenanceAdapters({ script });
  let cp=onlyFeedbackAndRoulette();let result;
  for(let i=0;i<11;i++){result=await adapters.priority.step({job:{id:1,planDate:TODAY,startedAt:CLOCK,checkpoint:cp},deadline:DEADLINE});cp=result.checkpoint;}
  assert.equal(cnt(log, 'rpc:finish_flight_price_audit'), 10, 'bounded audit batch drained first');
  assert.equal(cnt(log, 'rpc:collection_commit_roulette'), 1, 'roulette progressed after the audit bound');
  assert.equal(result.checkpoint.roulette.cursor, 1);
});

// ── 9. A large feedback queue is drained in small bounded batches (one claim per turn-0 visit) ───
test('9. a busy feedback queue is processed in bounded portions (≤1 claim per maintenance step)', async () => {
  const script = { rpc: { claim_flight_price_audit: [{ data: [{ feedback_id: 'f1', claim_token: 't1', feedback: {} }], error: null }],
    finish_flight_price_audit: [{ data: true, error: null }] } };
  const { adapters, log } = maintenanceAdapters({ script });
  const cp = onlyFeedbackAndRoulette({ roulette: { cycle: 1, cursor: 0, done: true } });
  await adapters.priority.step({ job: { id: 1, planDate: TODAY, startedAt: CLOCK, checkpoint: cp }, deadline: DEADLINE });
  assert.equal(cnt(log, 'rpc:claim_flight_price_audit'), 1, 'exactly one item claimed per step — no monopolizing the window');
});

// ── 11. A transient DB failure inside maintenance is retried and the checkpoint still advances ───
test('11. transient DB failure during the roulette recheck is retried without losing progress', async () => {
  const T = { status: 503, error: { code: '', message: 'fetch failed' } };
  const script = { from: { [POOL]: [T, { data: [{ snapshot_at: 'S1' }], error: null }, { data: [TICKET], error: null }] }, // first pool read transient, then ok
    rpc: { collection_commit_roulette: [{ data: true, error: null }], collection_revive_route: [{ data: true, error: null }],
      claim_flight_price_audit: [{ data: [], error: null }] } };
  const { adapters, log } = maintenanceAdapters({ script });
  const r = await adapters.priority.step({ job: { id: 1, planDate: TODAY, startedAt: CLOCK, checkpoint: onlyFeedbackAndRoulette() }, deadline: DEADLINE });
  assert.ok(cnt(log, 'from:' + POOL) >= 3, 'the transient pool read was retried (extra builder)');
  assert.equal(r.checkpoint.roulette.cursor, 1, 'checkpoint still advanced after the retry');
});

// ── 12b. Non-idempotent finalize is never auto-retried ──────────────────────────────────────────
test('12b. finish_flight_price_audit is not retried on a transient error', async () => {
  const T = { status: 503, error: { code: '', message: 'fetch failed' } };
  const script = { rpc: { claim_flight_price_audit: [{ data: [{ feedback_id: 'f1', claim_token: 't1', feedback: {} }], error: null }],
    finish_flight_price_audit: [T] } };
  const { adapters, log } = maintenanceAdapters({ script });
  await assert.rejects(() => adapters.priority.step({ job: { id: 1, planDate: TODAY, startedAt: CLOCK, checkpoint: onlyFeedbackAndRoulette({ roulette: { cycle: 1, cursor: 0, done: true } }) }, deadline: DEADLINE }),
    /Collection database operation failed/);
  assert.equal(cnt(log, 'rpc:finish_flight_price_audit'), 1, 'single attempt — no auto-retry of a non-idempotent finalize');
});

// ── 13. After a failed session, the next session resumes the same maintenance queue ─────────────
test('13. after an error, the next maintenance step resumes and processes the queue', async () => {
  const perm = { status: 403, error: { code: '42501', message: 'denied' } };
  // First step: claim throws permanently (not masked). Second step: claim ok → finalized.
  const script = { rpc: { claim_flight_price_audit: [perm, { data: [{ feedback_id: 'f1', claim_token: 't1', feedback: {} }], error: null }],
    finish_flight_price_audit: [{ data: true, error: null }] } };
  const { adapters, log } = maintenanceAdapters({ script });
  const cp = onlyFeedbackAndRoulette({ roulette: { cycle: 1, cursor: 0, done: true } });
  await assert.rejects(() => adapters.priority.step({ job: { id: 1, planDate: TODAY, startedAt: CLOCK, checkpoint: cp }, deadline: DEADLINE }), /42501/);
  await adapters.priority.step({ job: { id: 1, planDate: TODAY, startedAt: CLOCK, checkpoint: cp }, deadline: DEADLINE });
  assert.equal(cnt(log, 'rpc:finish_flight_price_audit'), 1, 'the next session finalized the item');
});

// ── Slot integration: main-at-risk borrows ONLY tail; fast/maintenance/reserve untouched ────────
function atRiskState(frameMinute, phaseIndex) {
  const s = freshScheduleState();
  s.jobs.main = { id: 0, planDate: TODAY, checkpoint: { cursor: 100, total: 100000, errors: 0, wave: 43 }, done: false, startedAt: 110 * MINMS, completedAt: null, retryAt: 0, activeMs: 60000 };
  s.frame = { cycle: 48, phase: phaseIndex, spentMs: 0 };
  return s;
}
const clockAt = (min) => 1440 * MINMS + min * MINMS;   // cycle 12, given minute
function ranEngine(state, clock, guaranteeDailyMain, ran) {
  return new SequentialSchedule({ state, clock: () => clock, lease: async () => true, save: async () => {}, guaranteeDailyMain,
    handlers: {
      fast: { maxUnitMs: 100, step: async () => { ran.push('fast'); return { status: 'progress', checkpoint: { cursor: 1, total: 400 } }; } },
      main: { maxUnitMs: 100, step: async () => { ran.push('main'); return { status: 'progress', checkpoint: { cursor: 200, total: 100000, wave: 43 } }; } },
      tail: { maxUnitMs: 100, step: async () => { ran.push('tail'); return { status: 'progress', checkpoint: { cursor: 501, total: 900000 } }; } },
      maintenance: { maxUnitMs: 100, step: async () => { ran.push('maintenance'); return { status: 'progress', checkpoint: { turn: 1 } }; } },
    } });
}

test('2. main-at-risk does NOT take the fast slot', async () => {
  const ran = []; const r = await ranEngine(atRiskState(2, 1), clockAt(2), true, ran).tick();
  assert.equal(r.task, 'fast'); assert.deepEqual(ran, ['fast']);
});
test('3. main-at-risk does NOT take a maintenance slot', async () => {
  const ran = []; const r = await ranEngine(atRiskState(28, 4), clockAt(28), true, ran).tick();
  assert.equal(r.task, 'maintenance'); assert.deepEqual(ran, ['maintenance']);
});
test('14. tail yields to main ONLY in a tail slot (main runs its own slot as usual)', async () => {
  const ranTail = []; const rt = await ranEngine(atRiskState(27, 3), clockAt(27), true, ranTail).tick();
  assert.equal(rt.task, 'main');                          // tail slot yielded
  const ranMain = []; const rm = await ranEngine(atRiskState(20, 2), clockAt(20), true, ranMain).tick();
  assert.equal(rm.task, 'main');                          // main slot: main anyway
});
test('15. after main.done, a tail slot runs tail again', async () => {
  const s = atRiskState(27, 3); s.jobs.main.done = true;
  const ran = []; const r = await ranEngine(s, clockAt(27), true, ran).tick();
  assert.equal(r.task, 'tail'); assert.deepEqual(ran, ['tail']);
});
test('1. fast job id advances once per established two-hour cycle', () => {
  const s = freshScheduleState();
  const a = prepareJob(s, 'fast', 0).id;
  const b = prepareJob(s, 'fast', 4*CYCLE_MS).id;
  assert.equal(b - a, 1);
});
test('17. concurrent ticks are refused — strictly one unit in flight', async () => {
  let release; const pending = new Promise(r => { release = r; });
  const engine = new SequentialSchedule({ clock: () => clockAt(20), lease: async () => true, save: async () => {}, guaranteeDailyMain: true,
    state: atRiskState(20, 2), handlers: { main: { maxUnitMs: 100, step: async () => { await pending; return { status: 'progress', checkpoint: { cursor: 200, total: 100000 } }; } } } });
  const first = engine.tick();
  await assert.rejects(engine.tick(), /Concurrent/);
  release(); await first;
});

// ── 16. wave-43 finishes ≤24h in the six-healthy-session model, with ≥20% reserve ──────────────
test('16. wave-43 main completes ≤24h with ≥20% reserve (tail-yield + 6 healthy sessions)', async () => {
  const r = await simulate({ guaranteeDailyMain: true, sessions: 6, mainTotal: 17800, mainRate: 24, dbFailAt: null });
  assert.ok(r.elapsedMs <= MAIN_CYCLE, `≤24h, got ${(r.elapsedMs / 3600000).toFixed(1)}h`);
  assert.ok(reserveOf(r.elapsedMs) >= 0.20, `≥20% reserve, got ${(reserveOf(r.elapsedMs) * 100).toFixed(0)}%`);
});
