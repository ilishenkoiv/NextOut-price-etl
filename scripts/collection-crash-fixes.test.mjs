// Regression tests for the 2026-09-25 crash fixes:
//  - A1: snapshot-daily-origin-cheapest.mjs's main() must accept a string ISO snapshotAt, not
//    just a number, without crashing downstream in pilotSourcesReady's Number.isFinite check.
//  - the same, exercised through the real coordinator entry point (runDueDailySelection with the
//    real publishRoulette), per the audit's requested test.
import test from 'node:test';
import assert from 'node:assert/strict';

// The selection owner reads its service key at import time, so set it before importing.
process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key';
const { main: publishDailyRoulette } = await import('./snapshot-daily-origin-cheapest.mjs');
const { runDueDailySelection } = await import('./run-collection.mjs');

// A thenable that resolves a PostgREST-shaped { data, error } result, matching the chain shape
// snapshot-daily-origin-cheapest.mjs's main() calls on `supabase.from('offers')...`.
const settle = (result) => ({ then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected) });

const freshOffer = { origin: 'BER', market: 'de', dest: 'BCN', flight_type: 'any', price: 120,
  departure_at: '2027-01-10', return_at: '2027-01-17', transfers: 1, updated_at: '2026-09-25T05:00:00.000Z', price_source: null };

function stubDb({ offers = [freshOffer], publish = true } = {}) {
  const chain = {
    select() { return chain; }, gte() { return chain; }, gt() { return chain; }, order() { return chain; },
    range: () => settle({ data: offers, error: null }),
  };
  return { from: () => chain, rpc: () => settle({ data: publish, error: null }) };
}

// Selection no longer gates on source freshness (see roulette-selection-refresh.test.mjs) — these
// tests now confirm the original crash fix (an ISO-string / numeric snapshotAt never throws inside
// normalizeInstant/freshOriginFraction) against the current always-publish behavior.
test('main({snapshotAt: ISO string, pilotMarketSchedule: true}) with a stub DB does not crash', async () => {
  const db = stubDb();
  const result = await publishDailyRoulette({ db, snapshotAt: '2026-09-25T07:00:00.000Z', pilotMarketSchedule: true });
  assert.equal(result.rebuilt, true);
  assert.ok(typeof result.freshFraction === 'number', 'freshness is computed and returned, never gates the publish');
});

test('main() also accepts a numeric snapshotAt (unchanged behavior) and treats an unparsable instant as a clear error, not a crash', async () => {
  const db = stubDb();
  const result = await publishDailyRoulette({ db, snapshotAt: Date.parse('2026-09-25T07:00:00.000Z'), pilotMarketSchedule: true });
  assert.equal(result.rebuilt, true);
  await assert.rejects(() => publishDailyRoulette({ db, snapshotAt: 'not-a-date' }), /Invalid snapshot instant/);
});

test('runDueDailySelection with the real publishRoulette and a string-time snapshot does not throw', async () => {
  const instant = Date.parse('2026-09-25T07:00:00.000Z'); // past the legacy 03:30 Berlin threshold
  const state = { version: 1, jobs: {} };
  const store = { lease: async () => true, save: async () => {} };
  const db = stubDb();
  const result = await runDueDailySelection({
    state, store, db, wave: 0, instant, pilotMarketSchedule: true,
    publishRoulette: (args) => publishDailyRoulette({ ...args, db }),
    publishWindows: async () => ({ published: true }),
  });
  assert.equal(result.published, true);
  assert.equal(state.dailySelection.rouletteDone, true);
});
