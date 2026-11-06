import test from 'node:test';
import assert from 'node:assert/strict';
import { carouselReplacement, isBerlinSelectedRefreshDaytime, isCurrentConfirmedFare, remainingExactPool10, rouletteReplacement,
  selectCarouselAlternate, selectRouletteAlternate, selectedRefreshAdmission, withCurrentRouletteRevisionState } from './selected-price-refresh-contract.mjs';

const now = Date.parse('2026-11-06T12:00:00Z');
const fresh = { price: 99, transfers: 1, source_updated_at: '2026-11-06T11:40:00Z', exact_observed_at: '2026-11-06T11:40:00Z',
  refresh_status: 'fresh', price_source: { source: 'test' } };
const ticket = { observed_on: '2026-11-06', snapshot_at: '2026-11-06T03:30:00Z', origin: 'BER', dest: 'BCN',
  destination_id: 'barcelona', flight_type: 'any', rank: 1, departure_at: '2026-12-04', return_at: '2026-12-07' };

test('roulette alternate is only a current confirmed member of the exact remaining pool10', () => {
  const pool = Array.from({ length: 10 }, (_, index) => ({ ...ticket, ...fresh, rank: index + 1, dest: `D${index}`, departure_at: '2026-12-04', return_at: '2026-12-07' }));
  pool[0] = { ...ticket, ...fresh };
  pool[1] = { ...pool[1], dest: 'FCO', price: 71 };
  const revisions = pool.map(row => ({ ...row, visibility: 'verified', reason: null, generation: 1 }));
  const currentPool = withCurrentRouletteRevisionState(pool, revisions);
  assert.equal(remainingExactPool10(currentPool, ticket).length, 9);
  assert.equal(selectRouletteAlternate(currentPool, ticket, now).dest, 'FCO');
  assert.equal(rouletteReplacement(selectRouletteAlternate(currentPool, ticket, now)).price, 71);
  assert.equal(selectRouletteAlternate(currentPool.slice(0, 9), ticket, now), null, 'partial pool cannot authorise replacement');
  assert.equal(selectRouletteAlternate(currentPool.map(row => row.dest === 'FCO' ? { ...row, source_updated_at: '2026-11-06T11:29:59Z' } : row), ticket, now).dest, 'D2');
  const unavailable = withCurrentRouletteRevisionState(pool, revisions.map(row => row.dest === 'FCO'
    ? { ...row, visibility: 'excluded', reason: 'confirmed_absent' } : row));
  assert.equal(selectRouletteAlternate(unavailable, ticket, now).dest, 'D2', 'confirmed-unavailable city is never revived');
  assert.equal(selectRouletteAlternate(pool, ticket, now), null, 'missing persisted revision state retains the old ticket');
});

test('carousel alternate preserves exact dates and requires a different current confirmed city', () => {
  const candidates = [
    { ...ticket, ...fresh, position: 1 },
    { ...ticket, ...fresh, destination_id: 'rome', dest: 'FCO', position: 2, price: 88 },
    { ...ticket, ...fresh, destination_id: 'madrid', dest: 'MAD', position: 3, departure_at: '2026-12-11', return_at: '2026-12-14', price: 65 },
  ];
  const alternate = selectCarouselAlternate(candidates, ticket, now);
  assert.equal(alternate.destination_id, 'rome');
  assert.deepEqual(carouselReplacement(alternate), {
    observed_on: ticket.observed_on, snapshot_at: ticket.snapshot_at, origin: 'BER', destination_id: 'rome', dest: 'FCO',
    flight_type: 'any', departure_at: '2026-12-04', return_at: '2026-12-07',
    price: 88, transfers: 1, airline: null, updated_at: '2026-11-06T11:40:00Z', price_source: { source: 'test' },
  });
  assert.equal(selectCarouselAlternate(candidates.map(row => row.dest === 'FCO' ? { ...row, exact_observed_at: '2026-11-06T11:29:59Z' } : row), ticket, now), null);
  assert.equal(selectCarouselAlternate(candidates.map(row => row.dest === 'FCO' ? { ...row, refresh_status: 'unavailable' } : row), ticket, now), null,
    'confirmed-unavailable city is never a carousel alternate');
});

test('current confirmation rejects invalid, stale, future, and direct-with-transfer rows', () => {
  assert.equal(isCurrentConfirmedFare({ ...fresh, flight_type: 'any' }, now), true);
  assert.equal(isCurrentConfirmedFare({ ...fresh, flight_type: 'direct', transfers: 1 }, now), false);
  assert.equal(isCurrentConfirmedFare({ ...fresh, price: 0, flight_type: 'any' }, now), false);
  assert.equal(isCurrentConfirmedFare({ ...fresh, source_updated_at: '2026-11-06T12:05:01Z', flight_type: 'any' }, now), false);
});

test('durable control and Berlin daytime gate admit only the regular selected cadence', () => {
  assert.deepEqual(selectedRefreshAdmission({ enabled: true, generation: 1, main12h_rollback: false }), { active: true, generation: 1 });
  assert.deepEqual(selectedRefreshAdmission({ enabled: true, generation: 1, main12h_rollback: true }), { active: false, generation: null });
  assert.equal(isBerlinSelectedRefreshDaytime(Date.parse('2026-11-06T06:00:00Z')), true, '07:00 Berlin is admitted');
  assert.equal(isBerlinSelectedRefreshDaytime(Date.parse('2026-11-06T22:00:00Z')), false, '23:00 Berlin is outside daytime');
});
