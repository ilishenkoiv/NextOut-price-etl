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

function stubDb({ offers = [], publish = true } = {}) {
  const chain = {
    select() { return chain; }, gte() { return chain; }, gt() { return chain; }, order() { return chain; },
    range: () => settle({ data: offers, error: null }),
  };
  return { from: () => chain, rpc: () => settle({ data: publish, error: null }) };
}

test('main({snapshotAt: ISO string, pilotMarketSchedule: true}) with a stub DB does not crash', async () => {
  const db = stubDb(); // no offers: pilotSourcesReady fails freshness (0/22 origins), not a crash
  const result = await publishDailyRoulette({ db, snapshotAt: '2026-09-25T07:00:00.000Z', pilotMarketSchedule: true });
  assert.equal(result.rebuilt, false);
  assert.equal(result.reason, 'sources_not_fresh');
});

test('main() also accepts a numeric snapshotAt (unchanged behavior) and treats an unparsable instant as a clear error, not a crash', async () => {
  const db = stubDb();
  const result = await publishDailyRoulette({ db, snapshotAt: Date.parse('2026-09-25T07:00:00.000Z'), pilotMarketSchedule: true });
  assert.equal(result.reason, 'sources_not_fresh');
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
    publishWindows: async () => ({ published: false, reason: 'sources_not_fresh' }),
  });
  // Neither path is "done" (sources not fresh), but crucially nothing threw.
  assert.equal(result.published, false);
  assert.equal(state.dailySelection.rouletteDone, false);
});
