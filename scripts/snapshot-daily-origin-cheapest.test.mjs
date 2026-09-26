import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDailyCheapest, selectDailyCheapestPool, poolExistsForObservedOn, berlinObservedOn, nightlySelectionDue, publishedSnapshotOrigins,
  LEGACY_SELECTION_THRESHOLD_MINUTES, PILOT_SELECTION_THRESHOLD_MINUTES, pilotSourcesReady, freshOriginFraction,
  PILOT_SOURCE_FRESHNESS_MS, PILOT_MIN_FRESH_ORIGIN_COVERAGE } from './snapshot-daily-origin-cheapest.mjs';
import { readFileSync } from 'node:fs';

test('selects one deterministic cheapest real future offer per origin and flight type', () => {
  const rows = selectDailyCheapest([
    { origin:'BER', dest:'PMI', flight_type:'any', price:80, departure_at:'2026-09-10', transfers:1, updated_at:'2026-08-25' },
    { origin:'BER', dest:'TIA', flight_type:'any', price:80, departure_at:'2026-09-12', transfers:0, updated_at:'2026-08-26' },
    { origin:'BER', dest:'PMI', flight_type:'direct', price:95, departure_at:'2026-09-10', transfers:0 },
    { origin:'MUC', dest:'FCO', flight_type:'any', price:0, departure_at:'2026-09-10', transfers:0 },
    { origin:'MUC', dest:'ATH', flight_type:'any', price:90, departure_at:'2026-08-01', transfers:0 },
  ], '2026-08-26');
  assert.deepEqual(rows.map((r) => [r.origin,r.flight_type,r.dest]), [
    ['BER','any','TIA'], ['BER','direct','PMI'],
  ]);
});

test('stores up to ten cheapest unique destinations per origin across any and direct', () => {
  const offers = Array.from({ length:12 }, (_, i) => ({
    origin:'BER', dest:`D${String(i).padStart(2, '0')}`, flight_type:'any', price:50 + i,
    departure_at:`2026-09-${String(10 + i).padStart(2, '0')}`, return_at:'2026-10-01', transfers:i % 2,
  }));
  offers.push({ ...offers[0], flight_type:'direct', departure_at:'2026-09-28', price:49 });
  const pool = selectDailyCheapestPool(offers, '2026-08-26');
  assert.equal(pool.length, 10);
  assert.deepEqual(pool.map((row) => row.rank), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(pool[0].price, 49);
  assert.equal(new Set(pool.map((row) => row.dest)).size, 10);
  assert.equal(pool[0].flight_type, 'direct');
});

test('production selection derives the approved canonical 22 origins from the shared catalogue',()=>{
  assert.equal(publishedSnapshotOrigins().size,22);
});

test('MUC Rome date flood occupies one rank and cannot crowd out other cities', () => {
  const rome = Array.from({ length:10 }, (_, i) => ({
    origin:'MUC', dest:'FCO', flight_type:'direct', price:62 + i,
    departure_at:`2026-11-${String(1 + i).padStart(2, '0')}`, return_at:'2026-11-20', transfers:0,
  }));
  const alternatives = ['PMO','SJJ','OPO','ALC','TBS','DBV','LJU','VAR','ATH'].map((dest, i) => ({
    origin:'MUC', dest, flight_type:'any', price:150 + i,
    departure_at:'2026-12-01', return_at:'2026-12-08', transfers:1,
  }));
  const pool = selectDailyCheapestPool([...rome, ...alternatives], '2026-08-31');
  assert.equal(pool.length, 10);
  assert.deepEqual(pool.map((row) => row.dest), ['FCO', ...alternatives.map((row) => row.dest)]);
  assert.equal(pool.filter((row) => row.dest === 'FCO').length, 1);
});

test('the same destination reachable by any and direct is never duplicated in the pool', () => {
  const pool = selectDailyCheapestPool([
    { origin:'MUC', dest:'FCO', flight_type:'any', price:120, departure_at:'2026-11-10', return_at:'2026-11-17', transfers:1 },
    { origin:'MUC', dest:'FCO', flight_type:'direct', price:95, departure_at:'2026-11-10', return_at:'2026-11-17', transfers:0 },
    { origin:'MUC', dest:'ATH', flight_type:'any', price:130, departure_at:'2026-11-12', return_at:'2026-11-19', transfers:1 },
  ], '2026-08-31');
  const fco = pool.filter((row) => row.dest === 'FCO');
  assert.equal(fco.length, 1, 'FCO appears exactly once across any+direct');
  assert.equal(fco[0].flight_type, 'direct', 'the cheaper direct fare wins the single slot');
  assert.equal(new Set(pool.map((r) => r.dest)).size, pool.length, 'every pooled destination is unique per origin');
});

test('poolExistsForObservedOn is the once-per-day selection guard predicate', () => {
  assert.equal(poolExistsForObservedOn([], '2026-09-21'), false, 'no rows -> selection may run');
  assert.equal(poolExistsForObservedOn(null, '2026-09-21'), false, 'a null probe never blocks selection');
  assert.equal(poolExistsForObservedOn([{ observed_on:'2026-09-21' }], '2026-09-21'), true, 'a matching day blocks re-selection');
  assert.equal(poolExistsForObservedOn([{ observed_on:'2026-09-20' }], '2026-09-21'), false, 'a different day does not block today');
});

test('Berlin observed day survives midnight and both DST transitions',()=>{
  assert.equal(berlinObservedOn('2026-03-29T00:30:00Z'),'2026-03-29');
  assert.equal(berlinObservedOn('2026-03-29T22:30:00Z'),'2026-03-30');
  assert.equal(berlinObservedOn('2026-10-25T00:30:00Z'),'2026-10-25');
  assert.equal(berlinObservedOn('2026-10-25T23:30:00Z'),'2026-10-26');
});

test('nightly due gate is 03:30 Berlin on winter, spring-DST and fall-DST days',()=>{
  assert.equal(nightlySelectionDue('2027-01-05T02:29:59Z'),false);
  assert.equal(nightlySelectionDue('2027-01-05T02:30:00Z'),true);
  assert.equal(nightlySelectionDue('2026-03-29T01:29:59Z'),false); // 03:29:59 CEST
  assert.equal(nightlySelectionDue('2026-03-29T01:30:00Z'),true);
  assert.equal(nightlySelectionDue('2026-10-25T02:29:59Z'),false); // 03:29:59 CET
  assert.equal(nightlySelectionDue('2026-10-25T02:30:00Z'),true);
});

test('a pilot (later) threshold overrides the legacy 03:30 default without changing it', () => {
  assert.equal(LEGACY_SELECTION_THRESHOLD_MINUTES, 3 * 60 + 30);
  assert.equal(PILOT_SELECTION_THRESHOLD_MINUTES, 6 * 60);
  // 03:30 Berlin (legacy-due) is still inside the pilot's night gap — not due under the pilot threshold.
  assert.equal(nightlySelectionDue('2026-01-15T02:30:00Z', PILOT_SELECTION_THRESHOLD_MINUTES), false);
  assert.equal(nightlySelectionDue('2026-01-15T04:59:59Z', PILOT_SELECTION_THRESHOLD_MINUTES), false); // 05:59:59
  assert.equal(nightlySelectionDue('2026-01-15T05:00:00Z', PILOT_SELECTION_THRESHOLD_MINUTES), true); // 06:00:00
  // Calling with no threshold argument is untouched — exact legacy behavior.
  assert.equal(nightlySelectionDue('2026-01-15T02:30:00Z'), true);
});

test('nightlySelectionDue rejects an out-of-range threshold instead of silently misfiring', () => {
  assert.throws(() => nightlySelectionDue(Date.now(), -1), /Invalid selection threshold/);
  assert.throws(() => nightlySelectionDue(Date.now(), 24 * 60), /Invalid selection threshold/);
});

test('pilotSourcesReady requires most expected origins to show a fresh offer, not just any offer within 36h', () => {
  const now = Date.parse('2026-09-24T05:05:00Z');
  const expected = new Set(['FRA', 'MUC', 'LHR', 'AMS']);
  const freshRow = (origin, ageMs) => ({ origin, updated_at: new Date(now - ageMs).toISOString() });
  // All fresh (well inside 3h) — ready.
  assert.equal(pilotSourcesReady([freshRow('FRA', 5 * 60000), freshRow('MUC', 5 * 60000), freshRow('LHR', 5 * 60000), freshRow('AMS', 5 * 60000)], now, expected), true);
  // All stale (>3h, e.g. only pre-pause data survived) — not ready, even though well inside the blanket 36h eligibility window.
  assert.equal(pilotSourcesReady([freshRow('FRA', 8 * 3600000), freshRow('MUC', 8 * 3600000), freshRow('LHR', 8 * 3600000), freshRow('AMS', 8 * 3600000)], now, expected), false);
  // Only 1/4 fresh (25% < 90% coverage) — not ready.
  assert.equal(pilotSourcesReady([freshRow('FRA', 5 * 60000), freshRow('MUC', 8 * 3600000), freshRow('LHR', 8 * 3600000), freshRow('AMS', 8 * 3600000)], now, expected), false);
  // An origin missing from `rows` entirely counts against coverage exactly like a stale one.
  assert.equal(pilotSourcesReady([freshRow('FRA', 5 * 60000), freshRow('MUC', 5 * 60000), freshRow('LHR', 5 * 60000)], now, expected), false);
  // No expected origins at all → never ready (fails closed, not vacuously true).
  assert.equal(pilotSourcesReady([freshRow('FRA', 5 * 60000)], now, new Set()), false);
});

test('pilotSourcesReady respects the exact freshness boundary and rejects a bad instant', () => {
  const now = Date.parse('2026-09-24T05:05:00Z');
  const expected = new Set(['FRA']);
  assert.equal(pilotSourcesReady([{ origin: 'FRA', updated_at: new Date(now - PILOT_SOURCE_FRESHNESS_MS).toISOString() }], now, expected), true); // exactly at the boundary — inclusive
  assert.equal(pilotSourcesReady([{ origin: 'FRA', updated_at: new Date(now - PILOT_SOURCE_FRESHNESS_MS - 1000).toISOString() }], now, expected), false);
  assert.throws(() => pilotSourcesReady([], NaN, expected), /Invalid instant/);
});

test('selection never gates on source freshness: neither daily-publish script early-returns sources_not_fresh any more', () => {
  const originSource = readFileSync(new URL('./snapshot-daily-origin-cheapest.mjs', import.meta.url), 'utf8');
  const windowSource = readFileSync(new URL('./snapshot-daily-window-candidates.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(originSource, /reason:'sources_not_fresh'/);
  assert.doesNotMatch(windowSource, /reason:'sources_not_fresh'/);
  // The freshness fraction is still computed and logged — just never used to gate publication.
  assert.match(originSource, /freshOriginFraction\(offers, ?instant, ?origins\)/);
  assert.match(windowSource, /freshOriginFraction\(rows,instant,publishedSnapshotOrigins\(\)\)/);
  assert.match(originSource, /daily_selection_published/);
  assert.match(windowSource, /daily_selection_published/);
});

test('freshOriginFraction: partial coverage returns the exact fraction, not a boolean; pilotSourcesReady reuses it against the coverage threshold', () => {
  const now = Date.parse('2026-09-24T05:05:00Z');
  const expected = new Set(['FRA', 'MUC', 'LHR', 'AMS']);
  const freshRow = (origin, ageMs) => ({ origin, updated_at: new Date(now - ageMs).toISOString() });
  assert.equal(freshOriginFraction([freshRow('FRA', 5 * 60000), freshRow('MUC', 8 * 3600000), freshRow('LHR', 8 * 3600000), freshRow('AMS', 8 * 3600000)], now, expected), 0.25);
  assert.equal(freshOriginFraction([], now, new Set()), 0, 'no expected origins at all -> fraction 0, never a divide-by-zero');
  assert.throws(() => freshOriginFraction([], NaN, expected), /Invalid instant/);
  // pilotSourcesReady is now a thin wrapper: true only once the fraction clears minCoverage.
  assert.equal(pilotSourcesReady([freshRow('FRA', 5 * 60000), freshRow('MUC', 5 * 60000), freshRow('LHR', 5 * 60000), freshRow('AMS', 5 * 60000)], now, expected), true);
  assert.equal(pilotSourcesReady([freshRow('FRA', 5 * 60000)], now, expected), false);
});

// main()-level behavior (immediate publish + point-refresh) is covered in
// roulette-selection-refresh.test.mjs, which already handles the service-key-read-at-import-time
// ordering (dynamic import after setting process.env.SUPABASE_SERVICE_KEY).

test('production snapshot query refuses source observations older than 36 hours', () => {
  const source = readFileSync(new URL('./snapshot-daily-origin-cheapest.mjs', import.meta.url), 'utf8');
  assert.match(source, /MAX_SOURCE_AGE_MS = 36 \* 60 \* 60 \* 1000/);
  assert.match(source, /\.gte\('updated_at', freshSince\)/);
});

test('legacy standalone workflow is preserved unchanged behind COLLECTION_MODE', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/snapshot-daily-origin-cheapest.yml', import.meta.url),
    'utf8',
  );
  assert.match(workflow, /^\s*schedule:/m);
  assert.match(workflow, /cron: '7,37 \* \* \* \*'/);
  assert.match(workflow, /^\s*workflow_run:/m);
  assert.match(workflow, /vars.COLLECTION_MODE != 'coordinated'/);
  assert.match(workflow, /workflow_dispatch/);
  assert.match(workflow, /node scripts\/refresh-roulette-prices\.mjs/, 'legacy refresh code is retained for manual fallback');
});

test('single coordinator owns scheduled daily selection; standalone selector is manual recovery only', () => {
  const recovery = readFileSync(
    new URL('../.github/workflows/nightly-cheapest-selection.yml', import.meta.url),
    'utf8',
  );
  const coordinator=readFileSync(new URL('./run-collection.mjs',import.meta.url),'utf8');
  assert.match(recovery,/name: Nightly cheapest offers selection/);assert.match(recovery,/workflow_dispatch:/);
  assert.doesNotMatch(recovery,/^\s*schedule:/m);assert.doesNotMatch(recovery,/^\s*workflow_run:/m);
  assert.match(coordinator,/runDueDailySelection/);assert.match(coordinator,/nightlySelectionDue/);
  assert.match(coordinator,/store\.lease\(\)/);assert.match(coordinator,/store\.save\(state\)/);
});
