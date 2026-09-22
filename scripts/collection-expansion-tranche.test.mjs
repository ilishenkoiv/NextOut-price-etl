// Expansion tranche — proofs that the 43 expansion destinations get bounded, fair, resumable
// collection time INSIDE the existing sequential collector, without starving MAIN/FAST/TAIL/
// MAINTENANCE and without a parallel scheduler.
//
// These tests drive the REAL planner (mainPlan/selectExpansionTranche/expansionStatus), the REAL
// main adapter (createAdapters().main.step) and the REAL SequentialSchedule. They deliberately use
// the full wave-43 plan (3992 routes × 6 months ≈ 23.9k cells) so the "is expansion work actually
// selected despite a large MAIN plan?" question is answered against a realistic plan size, not a toy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mainPlan, selectExpansionTranche, expansionStatus, resolveTrancheDests, EXPANSION_TRANCHE_MAX_DESTS, horizon } from './collection-planning.mjs';
import { expansionTargets, EXPANSION_TARGETS } from '../src/data/expansion-targets.js';
import { ORIGINS_ALL } from '../src/data/origins.js';
import { DESTINATIONS } from '../src/data/destinations.js';
import { createAdapters } from './collection-adapters.mjs';
import { SequentialSchedule, freshScheduleState } from './collection-schedule.mjs';

const DATE = '2026-09-21';
const WAVE = 43;
const dayOf = d => Math.floor(Date.parse(d) / 86400000);
const isoAfter = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10);

// Rows that mark a set of expansion destinations as fully collected for the horizon.
function completeRows(dests, date = DATE) {
  const months = horizon(date);
  return dests.flatMap(dest => ORIGINS_ALL.filter(o => o !== dest)
    .flatMap(o => months.map(m => ({ origin: o, dest, month: m, direct: 100, any_stops: 100 }))));
}
// Map a plan cell id (month-major: id = monthIndex*R + routeIndex) back to its destination.
const cellDest = (plan, id) => plan.routes[id % plan.routes.length].dest;

test('1+2+16: the full wave-43 plan front-loads incomplete expansion cells regardless of alphabetical position', () => {
  const plan = mainPlan({ date: DATE, wave: WAVE, prices: [], watches: [] });
  const R = plan.routes.length, M = plan.months.length;
  assert.equal(R, 3992);                                   // real wave-43 route set (base 139 + 43 expansion)
  assert.equal(plan.cellOrder.length, R * M);              // a permutation of EVERY cell — nothing dropped
  assert.equal(new Set(plan.cellOrder).size, R * M);       // …and it is a true permutation (no dupes/holes)

  // 16: all 139 base destinations still present in the normal plan.
  const planDests = new Set(plan.routes.map(r => r.dest));
  for (const d of DESTINATIONS) assert.ok(planDests.has(d.iata), `base destination ${d.iata} still collected`);

  // The tranche is bounded and drawn only from expansion destinations.
  const expansionIatas = new Set(EXPANSION_TARGETS.map(t => t.iata));
  assert.ok(plan.tranche.length > 0 && plan.tranche.length <= EXPANSION_TRANCHE_MAX_DESTS);
  assert.ok(plan.tranche.every(d => expansionIatas.has(d)));

  // Every head cell (front of cellOrder) is a tranche expansion cell; the head is exactly
  // (routes-to-tranche-dests × months) long. This is the independence-from-alphabetical-position proof:
  const trancheSet = new Set(plan.tranche);
  const headLen = plan.routes.filter(r => trancheSet.has(r.dest)).length * M;
  for (let i = 0; i < headLen; i++) assert.ok(trancheSet.has(cellDest(plan, plan.cellOrder[i])), `head cell ${i} is a tranche cell`);
  assert.ok(!trancheSet.has(cellDest(plan, plan.cellOrder[headLen])), 'the cell after the head is normal MAIN work');

  // Concrete independence: a tranche destination that sorts near the END of the alphabet still lands at
  // the very front of collection. Its natural (identity) first-cell id is large; its tranche position is 0.
  const lateDest = [...plan.tranche].sort().at(-1);
  const identityId = plan.routes.findIndex(r => r.dest === lateDest);  // month 0 identity cell id
  const tranchePos = plan.cellOrder.indexOf(identityId);
  assert.ok(tranchePos < headLen, `${lateDest} collected in the tranche head (pos ${tranchePos}) despite identity id ${identityId}`);
});

test('3+17: complete expansion destinations are skipped and never treated as new work', () => {
  const complete = EXPANSION_TARGETS.slice(0, 10).map(t => t.iata);   // the 10 already-warm destinations
  const prices = completeRows(complete);
  const status = expansionStatus({ date: DATE, wave: WAVE, prices });
  assert.equal(status.filter(s => s.complete).length, 10);
  assert.equal(status.filter(s => !s.complete).length, 33);
  for (const iata of complete) assert.ok(status.find(s => s.iata === iata).complete, `${iata} is complete`);

  // Across every rotation day, no complete destination is ever selected into the tranche.
  // (Rebuild the completeness rows per date so they always cover that date's 6-month horizon.)
  const completeSet = new Set(complete);
  for (let k = 0; k < 12; k++) {
    const date = isoAfter(DATE, k);
    const tranche = selectExpansionTranche({ date, wave: WAVE, prices: completeRows(complete, date) });
    assert.ok(tranche.every(d => !completeSet.has(d)), `day+${k} tranche excludes complete destinations`);
  }
  // …and a complete destination's cells are NOT in the plan's front-loaded head.
  const plan = mainPlan({ date: DATE, wave: WAVE, prices, watches: [] });
  const trancheSet = new Set(plan.tranche);
  assert.ok(complete.every(d => !trancheSet.has(d)));
});

test('4+13: cellOrder is a stable permutation → resume + idempotent retry replay the exact same cells', () => {
  const a = mainPlan({ date: DATE, wave: WAVE, prices: [], watches: [] });
  const b = mainPlan({ date: DATE, wave: WAVE, prices: [], watches: [] });
  // Deterministic for a given (date, wave, prices): a resumed session rebuilds the identical order,
  // and a retry of a lost unit re-selects the identical cell — the basis of checkpoint/resume + idempotency.
  assert.deepEqual(a.cellOrder, b.cellOrder);
  assert.deepEqual(a.tranche, b.tranche);
  // Resuming at any cursor k continues at exactly cellOrder[k]; no cell is skipped or repeated.
  for (const k of [0, 100, 1583, 1584, 5000]) assert.equal(a.cellOrder[k], b.cellOrder[k]);
});

test('5: the tranche has a hard bounded size (≤ MAX dests, ≤ ~1584 cells) at any horizon', () => {
  for (let k = 0; k < 8; k++) {
    const tranche = selectExpansionTranche({ date: isoAfter(DATE, k), wave: WAVE, prices: [] });
    assert.ok(tranche.length <= EXPANSION_TRANCHE_MAX_DESTS, `day+${k}: ${tranche.length} ≤ ${EXPANSION_TRANCHE_MAX_DESTS}`);
    assert.equal(new Set(tranche).size, tranche.length, 'no destination selected twice in one tranche');
  }
  // Cell budget of a full tranche: ≤ 12 dests × 22 origins × 6 months.
  const plan = mainPlan({ date: DATE, wave: WAVE, prices: [], watches: [] });
  const headLen = plan.routes.filter(r => plan.tranche.includes(r.dest)).length * plan.months.length;
  assert.ok(headLen <= EXPANSION_TRANCHE_MAX_DESTS * ORIGINS_ALL.length * plan.months.length);
});

test('6+SHRINKING-SET: as destinations complete, the remaining incomplete ones are always the ones selected', () => {
  // With 40 complete, the remaining 3 (least covered) are all selected in a single tranche — the
  // eligible set only shrinks and a nearly-warm wave cannot starve its last few destinations.
  const rest = EXPANSION_TARGETS.slice(0, 40).map(t => t.iata);
  const tranche = selectExpansionTranche({ date: DATE, wave: WAVE, prices: completeRows(rest) });
  assert.deepEqual(tranche.sort(), EXPANSION_TARGETS.slice(40).map(t => t.iata).sort());
});

test('2-LIFECYCLE: a real multi-pass lifecycle warms all 43 with no destination starved (least-covered-first)', () => {
  // Drives the REAL planner (mainPlan/selectExpansionTranche) across many passes. The DB coverage
  // accumulates between passes; passes advance by an IRREGULAR number of days (a pass may span >24h)
  // and one in three is INTERRUPTED (collects only a third of a head, modelling a stop mid-pass that
  // resumes on the next pass via the durable DB rows). No calendar-day rotation is assumed anywhere.
  const months = horizon(DATE);
  const requiredCells = dest => ORIGINS_ALL.filter(o => o !== dest).length * months.length;
  const covered = new Map(EXPANSION_TARGETS.map(t => [t.iata, new Set()]));
  const isComplete = dest => covered.get(dest).size >= requiredCells(dest);
  const pricesFrom = () => [...covered].flatMap(([dest, set]) => [...set].map(cell => {
    const [origin, month] = cell.split('|'); return { origin, dest, month, direct: 100, any_stops: 100 };
  }));
  const HEAD_CELLS = EXPANSION_TRANCHE_MAX_DESTS * ORIGINS_ALL.length * months.length;   // one healthy session

  const selectedEver = new Set();
  let minCoverage = 0, planDay = 0, pass = 0;
  while ([...covered.keys()].some(d => !isComplete(d)) && pass < 200) {
    const plan = mainPlan({ date: isoAfter(DATE, planDay), wave: WAVE, prices: pricesFrom(), watches: [] });
    const tranche = plan.tranche ?? [];
    assert.ok(tranche.length <= EXPANSION_TRANCHE_MAX_DESTS, 'tranche stays bounded every pass');
    for (const d of tranche) selectedEver.add(d);
    const budget = pass % 3 === 0 ? Math.floor(HEAD_CELLS / 3) : HEAD_CELLS;   // interrupted vs healthy pass
    const trancheSet = new Set(tranche);
    let spent = 0;
    for (const id of plan.cellOrder ?? []) {
      if (spent >= budget) break;
      const route = plan.routes[id % plan.routes.length];
      if (!trancheSet.has(route.dest)) break;                                  // reached normal MAIN → head ended
      covered.get(route.dest).add(route.origin + '|' + plan.months[Math.floor(id / plan.routes.length)]);
      spent++;
    }
    // Fairness invariant: the minimum coverage among still-incomplete destinations never decreases.
    const incomplete = [...covered].filter(([d]) => !isComplete(d)).map(([d, s]) => s.size / requiredCells(d));
    const nextMin = incomplete.length ? Math.min(...incomplete) : 1;
    assert.ok(nextMin >= minCoverage - 1e-9, `min coverage is monotone (pass ${pass}: ${minCoverage} → ${nextMin})`);
    minCoverage = nextMin;
    planDay += 1 + (pass % 3);        // irregular, sometimes-multi-day gaps between passes
    pass++;
  }
  assert.ok([...covered.keys()].every(isComplete), `all 43 warmed (in ${pass} passes)`);
  assert.equal(selectedEver.size, 43, 'every one of the 43 was selected into a tranche at least once');
  assert.ok(pass < 200, `terminates in a bounded number of passes (${pass})`);
});

test('7-NO-STARVATION: the tranche is a small fraction of the plan, so normal MAIN keeps most of every session', () => {
  const plan = mainPlan({ date: DATE, wave: WAVE, prices: [], watches: [] });
  const headLen = plan.routes.filter(r => plan.tranche.includes(r.dest)).length * plan.months.length;
  const fraction = headLen / plan.cellOrder.length;
  // A ~2.6k-cell session commits ≈ 2640 cells; a ≤1584-cell tranche leaves ≥ ~1000 for normal MAIN,
  // and against the whole ~24k-cell plan the tranche is well under 10%.
  assert.ok(fraction < 0.10, `tranche is ${(fraction * 100).toFixed(1)}% of the plan (<10%)`);
  assert.ok(headLen <= 1584);
});

test('15: once every expansion destination is complete, cellOrder disappears and legacy MAIN ordering resumes', () => {
  const prices = completeRows(EXPANSION_TARGETS.map(t => t.iata));
  assert.deepEqual(selectExpansionTranche({ date: DATE, wave: WAVE, prices }), []);
  const plan = mainPlan({ date: DATE, wave: WAVE, prices, watches: [] });
  assert.equal(plan.cellOrder, undefined, 'no cellOrder → adapter uses the exact legacy identity ordering');
  assert.equal(plan.tranche, undefined);
  // wave 0 (expansion off) is likewise a no-op.
  assert.equal(mainPlan({ date: DATE, wave: 0, prices: [], watches: [] }).cellOrder, undefined);
});

// ── Adapter-level: prove the REAL main adapter actually collects the tranche cells FIRST ──────────
function mainFixture(plan, offer) {
  const calls = [];
  const chain = data => new Proxy({}, { get: (_, k) => k === 'then'
    ? Promise.resolve({ data, error: null }).then.bind(Promise.resolve({ data, error: null })) : () => chain(data) });
  const db = { rpc: (name, args) => { calls.push({ name, args }); return Promise.resolve({ data: true, error: null }); },
    from: () => chain([]), storage: { from: () => ({ upload: async () => ({ data: {}, error: null }) }) } };
  const store = { args: () => ({ p_owner: 'o', p_token: 1 }), lease: async () => true, plan: async () => plan, runId: '1' };
  const provider = { request: async () => ({ kind: 'ok', json: { success: true, data: [offer] } }) };
  return { adapters: createAdapters({ db, store, provider, clock: () => 100000, wave: WAVE }), calls };
}
const OFFER = { departure_at: '2027-01-10T08:00:00Z', return_at: '2027-01-17T09:00:00Z', price: 123, transfers: 0 };
// Small hand-built plan whose tranche destination (ZZZ) sorts LAST alphabetically and sits at the
// HIGHEST identity cell ids, yet cellOrder front-loads it. Month-major ids with R=2:
//   identity: 0=(m0,AAA) 1=(m0,ZZZ) 2=(m1,AAA) 3=(m1,ZZZ);  tranche(ZZZ) first → [1,3,0,2]
const ADAPTER_PLAN = { months: ['2027-01', '2027-02'], breakKeys: [],
  routes: [{ origin: 'FRA', dest: 'AAA', stops: 0, key: 'FRA|AAA' }, { origin: 'FRA', dest: 'ZZZ', stops: 0, key: 'FRA|ZZZ' }],
  cellOrder: [1, 3, 0, 2] };
const ADAPTER_JOB = { id: 1, planDate: DATE, startedAt: 100000, checkpoint: null };

test('2-ADAPTER: the real main adapter walks cellOrder — expansion (ZZZ) is committed before normal (AAA)', async () => {
  const f = mainFixture(ADAPTER_PLAN, OFFER);
  const result = await f.adapters.main.step({ job: ADAPTER_JOB, deadline: 200000 });
  const commits = f.calls.filter(c => c.name === 'collection_commit_main').map(c => c.args.p_price.dest);
  assert.deepEqual(commits, ['ZZZ', 'AAA'], 'priced ZZZ month is committed before the priced AAA month; empty months only update route health');
  assert.equal(result.checkpoint.cursor, 4);
  assert.equal(result.checkpoint.stage, 'complete');    // reached total → pass completes (no selection stage)
});

test('4-ADAPTER: a resumed pass continues from its checkpoint cursor within the same cellOrder', async () => {
  const f = mainFixture(ADAPTER_PLAN, OFFER);
  // Resume after the two ZZZ cells were already committed (cursor=2).
  const result = await f.adapters.main.step({ job: { ...ADAPTER_JOB, checkpoint: { cursor: 2, errors: 0, wave: WAVE } }, deadline: 200000 });
  const commits = f.calls.filter(c => c.name === 'collection_commit_main').map(c => c.args.p_price.dest);
  assert.deepEqual(commits, ['AAA'], 'resume collected only the remaining priced tail cell, none repeated');
  assert.equal(result.checkpoint.cursor, 4);
});

test('13-ADAPTER: replaying the same cursor produces the identical (idempotent) commit payload', async () => {
  const one = mainFixture(ADAPTER_PLAN, OFFER);
  const two = mainFixture(ADAPTER_PLAN, OFFER);
  const job = { ...ADAPTER_JOB, checkpoint: { cursor: 0, errors: 0, wave: WAVE } };
  await one.adapters.main.step({ job, deadline: 200000 });
  await two.adapters.main.step({ job, deadline: 200000 });
  assert.deepEqual(one.calls.map(c => c.args.p_price ?? null), two.calls.map(c => c.args.p_price ?? null));
});

// ── Scheduler-level: prove the tranche lives INSIDE `main` and starves nothing ───────────────────
function recorder(ran, task, result) { return { maxUnitMs: 100, step: async () => { ran.push(task); return result; } }; }

test('8+10+11-SCHEDULER: the tranche changes only MAIN\'s internal cell order, so every class still gets its slot', async () => {
  // Real SequentialSchedule walked across a full cycle. The expansion change touches ONLY the main
  // plan's cell ordering (collection-schedule.mjs is untouched), so slot allocation is unchanged: each
  // class is serviced from its own slot. main carries a wave-43 tranche checkpoint to make the point.
  const state = freshScheduleState();
  const ran = [];
  const engine = new SequentialSchedule({ state, clock: () => 5 * 60000, lease: async () => true, save: async () => {},
    handlers: {
      fast: recorder(ran, 'fast', { status: 'done', checkpoint: { cursor: 20, total: 20 } }),
      maintenance: recorder(ran, 'maintenance', { status: 'empty' }),
      main: recorder(ran, 'main', { status: 'done', checkpoint: { cursor: 24000, total: 24000, wave: WAVE } }),
      tail: recorder(ran, 'tail', { status: 'done', checkpoint: { cursor: 50, total: 50 } }),
    } });
  for (let i = 0; i < 12; i++) { const r = await engine.tick(); if (r.status === 'idle') break; }
  for (const cls of ['fast', 'maintenance', 'main', 'tail']) assert.ok(ran.includes(cls), `${cls} was serviced (not starved)`);
});

test('12+14-SCHEDULER: a transient failure inside the tranche does not advance or corrupt the cursor', async () => {
  const state = freshScheduleState();
  state.jobs.main = { id: 0, planDate: DATE, checkpoint: { cursor: 500, total: 24000, errors: 0, wave: WAVE },
    done: false, startedAt: 0, completedAt: null, retryAt: 0, activeMs: 0 };
  state.frame = { cycle: 0, phase: 2, spentMs: 0 };   // main slot (SLOTS[2] = 15–45)
  const engine = new SequentialSchedule({ state, clock: () => 16 * 60000, lease: async () => true, save: async () => {},
    handlers: { main: { maxUnitMs: 100, step: async () => { throw new Error('Collection database operation failed (transient)'); } } } });
  await assert.rejects(engine.tick(), /transient/);
  // The pre-work checkpoint is retained verbatim: the same cell is retried, nothing is skipped or double-counted.
  assert.equal(engine.state.jobs.main.checkpoint.cursor, 500);
  assert.equal(engine.state.jobs.main.done, false);
  assert.equal(engine.state.completedMain, 0);
});

// ── Review point 1: safe activation over an in-flight legacy pass (durable plan, no cellOrder) ────
test('1-LEGACY: an in-flight pass whose durable plan predates the tranche keeps its identity order — progress is not reset', async () => {
  // A pass that started before this change: its durable plan has NO cellOrder and its checkpoint is
  // non-zero. The adapter must keep collecting in identity order from the saved cursor (no reset, no
  // reorder). The tranche only takes effect on the NEXT pass, which builds a fresh plan with cellOrder.
  const legacyPlan = { months: ['2027-01'], breakKeys: [],
    routes: [{ origin: 'FRA', dest: 'AAA', stops: 0, key: 'FRA|AAA' },
             { origin: 'FRA', dest: 'BBB', stops: 0, key: 'FRA|BBB' },
             { origin: 'FRA', dest: 'CCC', stops: 0, key: 'FRA|CCC' }] };   // no cellOrder
  const f = mainFixture(legacyPlan, OFFER);
  const result = await f.adapters.main.step({ job: { ...ADAPTER_JOB, checkpoint: { cursor: 1, errors: 0, wave: WAVE } }, deadline: 200000 });
  const commits = f.calls.filter(c => c.name === 'collection_commit_main').map(c => c.args.p_price.dest);
  assert.deepEqual(commits, ['BBB', 'CCC'], 'resumed at identity cursor 1 — BBB then CCC, no reset, no reorder');
  assert.equal(result.checkpoint.cursor, 3);
});

// ── Review point 3: required-origin coverage; extraneous origins never substitute ─────────────────
test('3-REQUIRED-ORIGINS: an extraneous origin cannot mark a destination complete in place of a missing required one', () => {
  const months = horizon(DATE);
  const dest = EXPANSION_TARGETS[0].iata;                 // MAD
  const required = ORIGINS_ALL.filter(o => o !== dest);
  // Cover every REQUIRED origin except one, then add a bogus non-ORIGINS_ALL origin ("XXX") for the
  // gap month. The bogus rows must NOT count — the destination stays incomplete.
  const missing = required[0];
  const rows = [];
  for (const o of required) for (const m of months) if (!(o === missing)) rows.push({ origin: o, dest, month: m, direct: 100, any_stops: 100 });
  for (const m of months) rows.push({ origin: 'XXX', dest, month: m, direct: 100, any_stops: 100 });   // extraneous
  const s = expansionStatus({ date: DATE, wave: WAVE, prices: rows }).find(x => x.iata === dest);
  assert.equal(s.expected, required.length * months.length);
  assert.equal(s.have, (required.length - 1) * months.length, 'extraneous XXX rows are not counted');
  assert.equal(s.complete, false, 'still incomplete — the missing required origin is not substituted');
  // Filling the genuinely-missing required origin then completes it.
  for (const m of months) rows.push({ origin: missing, dest, month: m, direct: 100, any_stops: 100 });
  assert.equal(expansionStatus({ date: DATE, wave: WAVE, prices: rows }).find(x => x.iata === dest).complete, true);
});

// ── Review point 4: EXPANSION_TRANCHE_DESTS validation and enforced upper bound ───────────────────
test('4-VALIDATION: EXPANSION_TRANCHE_DESTS is validated and can never exceed the hard ceiling', () => {
  const MAX = EXPANSION_TRANCHE_MAX_DESTS;
  assert.equal(resolveTrancheDests(undefined), MAX, 'unset → default (ceiling)');
  assert.equal(resolveTrancheDests(''), MAX, 'empty → default');
  assert.equal(resolveTrancheDests('abc'), MAX, 'non-numeric → default, never unbounded/disabled by accident');
  assert.equal(resolveTrancheDests('7'), 7, 'numeric string honored');
  assert.equal(resolveTrancheDests(3.9), 3, 'fractional floored');
  assert.equal(resolveTrancheDests(1000), MAX, 'oversized clamped to the ceiling');
  assert.equal(resolveTrancheDests(Number.MAX_SAFE_INTEGER), MAX, 'overflow clamped to the ceiling');
  assert.equal(resolveTrancheDests(Infinity), MAX, 'Infinity → default (not finite)');
  assert.equal(resolveTrancheDests(0), 0, 'explicit disable');
  assert.equal(resolveTrancheDests(-5), 0, 'negative → disabled');
  // The bound is enforced end-to-end through selectExpansionTranche, not just at the env boundary.
  assert.ok(selectExpansionTranche({ date: DATE, wave: WAVE, prices: [], maxDests: 1000 }).length <= MAX);
  assert.equal(selectExpansionTranche({ date: DATE, wave: WAVE, prices: [], maxDests: 0 }).length, 0);
  assert.equal(selectExpansionTranche({ date: DATE, wave: WAVE, prices: [], maxDests: 4 }).length, 4);
});

// ── Review point 5: normal MAIN actually progresses under a bounded budget with slow requests ─────
// Advancing-clock fixture: the clock only moves when the provider is called, modelling slow network
// requests that consume the session's time budget. Commits are captured in order.
function slowFixture(plan, offer, stepMs) {
  const calls = [];
  let now = 100000;
  const chain = data => new Proxy({}, { get: (_, k) => k === 'then'
    ? Promise.resolve({ data, error: null }).then.bind(Promise.resolve({ data, error: null })) : () => chain(data) });
  const db = { rpc: (name, args) => { calls.push({ name, args }); return Promise.resolve({ data: true, error: null }); },
    from: () => chain([]), storage: { from: () => ({ upload: async () => ({ data: {}, error: null }) }) } };
  const store = { args: () => ({ p_owner: 'o', p_token: 1 }), lease: async () => true, plan: async () => plan, runId: '1' };
  const provider = { request: async () => { now += stepMs; return { kind: 'ok', json: { success: true, data: [offer] } }; } };
  return { adapters: createAdapters({ db, store, provider, clock: () => now, wave: WAVE }), calls };
}

test('5-MAIN-PROGRESS: under a bounded budget with slow requests, MAIN advances past the tranche into normal work', async () => {
  // 2 tranche cells (ZZZ) front-loaded, then 6 normal cells (one month). Slow requests consume the
  // ~30s unit budget so the pass CANNOT finish — proving behaviorally (not by plan-fraction arithmetic)
  // that after the bounded tranche head, ordinary MAIN cells are still collected within the session.
  const routes = [{ origin: 'FRA', dest: 'ZZZ', stops: 0, key: 'FRA|ZZZ' },
    ...['N1', 'N2', 'N3', 'N4', 'N5', 'N6'].map(d => ({ origin: 'FRA', dest: d, stops: 0, key: 'FRA|' + d }))];
  // month-major, 1 month, R=7: identity ids 0..6; ZZZ (index0) front-loaded first → [0,1,2,3,4,5,6]
  const plan = { months: ['2027-01'], breakKeys: [], routes, cellOrder: [0, 1, 2, 3, 4, 5, 6], tranche: ['ZZZ'] };
  const f = slowFixture(plan, OFFER, 2500);   // 2 requests/cell × 2500 ≈ 5s/cell against a ~15s usable window
  const result = await f.adapters.main.step({ job: { ...ADAPTER_JOB, checkpoint: { cursor: 0, errors: 0, wave: WAVE } }, deadline: 400000 });
  const commits = f.calls.filter(c => c.name === 'collection_commit_main').map(c => c.args.p_price.dest);
  assert.equal(result.status, 'progress');                       // budget bound: the pass did not finish
  assert.ok(result.checkpoint.cursor > 1 && result.checkpoint.cursor < routes.length, `budget-limited progress (cursor ${result.checkpoint.cursor})`);
  assert.equal(commits[0], 'ZZZ', 'tranche collected first');
  assert.ok(commits.slice(1).some(d => d.startsWith('N')), 'normal MAIN cells also collected in the same bounded session');
});
