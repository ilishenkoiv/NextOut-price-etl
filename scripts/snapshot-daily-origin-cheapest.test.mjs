import test from 'node:test';
import assert from 'node:assert/strict';
import { selectDailyCheapest } from './snapshot-daily-origin-cheapest.mjs';

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
