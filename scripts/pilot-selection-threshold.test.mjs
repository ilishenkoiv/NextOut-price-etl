// Regression tests for the 2026-09-26 owner spec:
//  - Daily full selection threshold moves from 07:05 to 06:00 Berlin under
//    PRIORITY_MARKET_SCHEDULE=pilot.
//  - The pilot path is the ONLY threshold consulted when pilotMarketSchedule is set — the
//    legacy 03:30 default must never re-gate a pilot-mode caller from inside main() itself
//    (both snapshot-daily-origin-cheapest.mjs and snapshot-daily-window-candidates.mjs used to
//    call nightlySelectionDue(instant) with no threshold argument, silently defaulting to legacy).
import test from 'node:test';
import assert from 'node:assert/strict';

// The selection owner reads its service key at import time, so set it before importing.
process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key';
const { main: publishDailyRoulette, PILOT_SELECTION_THRESHOLD_MINUTES } = await import('./snapshot-daily-origin-cheapest.mjs');
const { main: publishDailyWindows } = await import('./snapshot-daily-window-candidates.mjs');

const settle = (result) => ({ then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected) });
const freshOffer = { origin: 'BER', market: 'de', dest: 'BCN', flight_type: 'any', price: 120,
  departure_at: '2027-01-10', return_at: '2027-01-17', transfers: 1, updated_at: '2026-01-15T05:00:00.000Z', price_source: null };

function stubDb({ rows = [freshOffer], publish = true } = {}) {
  const chain = {
    select() { return chain; }, gte() { return chain; }, gt() { return chain; }, lte() { return chain; },
    order() { return chain; }, in() { return chain; },
    range: () => settle({ data: rows, error: null }),
  };
  return { from: () => chain, rpc: () => settle({ data: publish, error: null }) };
}

test('PILOT_SELECTION_THRESHOLD_MINUTES is 06:00 Berlin (360)', () => {
  assert.equal(PILOT_SELECTION_THRESHOLD_MINUTES, 6 * 60);
});

test('roulette selection (snapshot-daily-origin-cheapest.mjs): pilot threshold alone gates it — 05:59 not due, 06:00 due, legacy 03:30 never re-gates', async () => {
  const db = stubDb();
  const notYet = await publishDailyRoulette({ db, snapshotAt: '2026-01-15T04:59:00.000Z', pilotMarketSchedule: true }); // 05:59 Berlin (CET)
  assert.equal(notYet.rebuilt, false);
  assert.equal(notYet.reason, 'not_due');
  const due = await publishDailyRoulette({ db, snapshotAt: '2026-01-15T05:00:00.000Z', pilotMarketSchedule: true }); // 06:00 Berlin
  assert.equal(due.rebuilt, true);
});

test('window/carousel selection (snapshot-daily-window-candidates.mjs): same pilot-only gate at 06:00 Berlin', async () => {
  const window = { origin: 'BER', dest: 'BCN', flight_type: 'any', departure_at: '2027-01-10', return_at: '2027-01-17',
    price: 120, transfers: 1, airline: null, updated_at: '2026-01-15T05:00:00.000Z', price_source: null };
  const db = stubDb({ rows: [window] });
  const notYet = await publishDailyWindows({ db, instant: Date.parse('2026-01-15T04:59:00.000Z'), pilotMarketSchedule: true });
  assert.equal(notYet.published, false);
  assert.equal(notYet.reason, 'not_due');
});

test('without pilotMarketSchedule, both scripts keep the untouched legacy 03:30 default', async () => {
  const db = stubDb();
  const due = await publishDailyRoulette({ db, snapshotAt: '2026-01-15T02:30:00.000Z' }); // 03:30 Berlin, legacy-due
  assert.equal(due.rebuilt, true);
  const notDue = await publishDailyRoulette({ db, snapshotAt: '2026-01-15T02:29:00.000Z' }); // 03:29 Berlin, legacy not-yet-due
  assert.equal(notDue.reason, 'not_due');
  const window = { origin: 'BER', dest: 'BCN', flight_type: 'any', departure_at: '2027-01-10', return_at: '2027-01-17',
    price: 120, transfers: 1, airline: null, updated_at: '2026-01-15T02:00:00.000Z', price_source: null };
  const dbW = stubDb({ rows: [window] });
  const notDueW = await publishDailyWindows({ db: dbW, instant: Date.parse('2026-01-15T01:29:00.000Z') }); // 02:29 Berlin
  assert.equal(notDueW.reason, 'not_due');
});
