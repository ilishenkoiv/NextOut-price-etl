import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDailyCheapest, selectDailyCheapestPool } from './snapshot-daily-origin-cheapest.mjs';
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

test('production snapshot query refuses source observations older than 36 hours', () => {
  const source = readFileSync(new URL('./snapshot-daily-origin-cheapest.mjs', import.meta.url), 'utf8');
  assert.match(source, /MAX_SOURCE_AGE_MS = 36 \* 60 \* 60 \* 1000/);
  assert.match(source, /\.gte\('updated_at', freshSince\)/);
});
