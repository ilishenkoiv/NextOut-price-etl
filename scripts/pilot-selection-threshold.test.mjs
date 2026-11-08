// Regression tests for the common 06:30 Europe/Berlin daily formation gate.
// Both named modes retain their own caller path, but must use the identical threshold.
import test from 'node:test';
import assert from 'node:assert/strict';

// The selection owner reads its service key at import time, so set it before importing.
process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key';
const { main: publishDailyRoulette, LEGACY_SELECTION_THRESHOLD_MINUTES, PILOT_SELECTION_THRESHOLD_MINUTES } = await import('./snapshot-daily-origin-cheapest.mjs');
const { main: publishDailyWindows } = await import('./snapshot-daily-window-candidates.mjs');

const settle = (result) => ({ then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected) });
const freshOffers = ['AMS','ATH','BCN','FCO','IST','LIS','PMI','PRG','VIE','ZRH'].map((dest,index)=>({
  origin:'BER',market:'de',dest,flight_type:'any',price:120+index,departure_at:'2027-01-10',return_at:'2027-01-17',
  transfers:1,updated_at:'2026-01-15T05:00:00.000Z',price_source:null}));

function stubDb({ rows = freshOffers, publish = true } = {}) {
  const chain = {
    select() { return chain; }, gte() { return chain; }, gt() { return chain; }, lte() { return chain; },
    order() { return chain; }, in() { return chain; },
    range: () => settle({ data: rows, error: null }),
  };
  return { from: () => chain, rpc: () => settle({ data: publish, error: null }) };
}

test('legacy and pilot formation thresholds are both 06:30 Berlin (390)', () => {
  assert.equal(LEGACY_SELECTION_THRESHOLD_MINUTES, 6 * 60 + 30);
  assert.equal(PILOT_SELECTION_THRESHOLD_MINUTES, 6 * 60 + 30);
});

test('roulette selection: 06:29 Berlin is not due and 06:30 is due', async () => {
  const db = stubDb();
  const notYet = await publishDailyRoulette({ db, snapshotAt: '2026-01-15T05:29:00.000Z', pilotMarketSchedule: true }); // 06:29 Berlin (CET)
  assert.equal(notYet.rebuilt, false);
  assert.equal(notYet.reason, 'not_due');
  const due = await publishDailyRoulette({ db, snapshotAt:'2026-01-15T05:30:00.000Z',pilotMarketSchedule:true,expectedOrigins:['BER'] }); // 06:30 Berlin
  assert.equal(due.rebuilt, true);
});

test('window/carousel selection: 06:29 Berlin is not due and 06:30 is due', async () => {
  const window = { origin: 'BER', dest: 'BCN', flight_type: 'any', departure_at: '2026-01-30', return_at: '2026-02-01',
    price: 120, transfers: 1, airline: null, updated_at: '2026-01-15T05:00:00.000Z', price_source: null };
  const db = stubDb({ rows: [window] });
  const notYet = await publishDailyWindows({ db, instant: Date.parse('2026-01-15T05:29:00.000Z'), pilotMarketSchedule: true });
  assert.equal(notYet.published, false);
  assert.equal(notYet.reason, 'not_due');
  const due = await publishDailyWindows({ db, instant: Date.parse('2026-01-15T05:30:00.000Z'), pilotMarketSchedule: true });
  assert.equal(due.published, true);
});

test('without pilotMarketSchedule, the legacy named path uses the same 06:30 gate', async () => {
  const db = stubDb();
  const due = await publishDailyRoulette({ db, snapshotAt:'2026-01-15T05:30:00.000Z',expectedOrigins:['BER'] }); // 06:30 Berlin
  assert.equal(due.rebuilt, true);
  const notDue = await publishDailyRoulette({ db, snapshotAt: '2026-01-15T05:29:00.000Z' }); // 06:29 Berlin
  assert.equal(notDue.reason, 'not_due');
  const window = { origin: 'BER', dest: 'BCN', flight_type: 'any', departure_at: '2026-01-30', return_at: '2026-02-01',
    price: 120, transfers: 1, airline: null, updated_at: '2026-01-15T05:00:00.000Z', price_source: null };
  const dbW = stubDb({ rows: [window] });
  const notDueW = await publishDailyWindows({ db: dbW, instant: Date.parse('2026-01-15T05:29:00.000Z') }); // 06:29 Berlin
  assert.equal(notDueW.reason, 'not_due');
  const dueW = await publishDailyWindows({ db: dbW, instant: Date.parse('2026-01-15T05:30:00.000Z') });
  assert.equal(dueW.published, true);
});
