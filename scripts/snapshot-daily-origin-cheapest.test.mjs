import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDailyCheapest, selectDailyCheapestPool } from './snapshot-daily-origin-cheapest.mjs';

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

test('stores up to ten deterministic distinct tickets per origin and flight type', () => {
  const offers = Array.from({ length:12 }, (_, i) => ({
    origin:'BER', dest:`D${String(i).padStart(2, '0')}`, flight_type:'any', price:50 + i,
    departure_at:`2026-09-${String(10 + i).padStart(2, '0')}`, return_at:'2026-10-01', transfers:i % 2,
  }));
  offers.push({ ...offers[0], price:49 }); // same ticket identity: keep its cheapest representation
  const pool = selectDailyCheapestPool(offers, '2026-08-26');
  assert.equal(pool.length, 10);
  assert.deepEqual(pool.map((row) => row.rank), [1,2,3,4,5,6,7,8,9,10]);
  assert.equal(pool[0].price, 49);
});
