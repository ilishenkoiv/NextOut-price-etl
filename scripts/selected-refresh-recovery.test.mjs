import test from 'node:test';
import assert from 'node:assert/strict';
import { assertManualSelectedRequest, assertSelectedControl, carouselResult, carouselTicket, rouletteResult, rouletteTicket } from './selected-refresh-recovery.mjs';

const ticket = { observed_on: '2026-11-05', snapshot_at: '2026-11-05T05:00:00Z', origin: 'BER', dest: 'BCN', destination_id: 'barcelona',
  flight_type: 'any', rank: 1, departure_at: '2026-12-04', return_at: '2026-12-07', transfers: 1 };

test('only the explicit fixed-duration owner-manual request is admitted before any provider or lease work', () => {
  assert.throws(() => assertManualSelectedRequest({}), /owner-manual only/);
  assert.throws(() => assertManualSelectedRequest({ SELECTED_REFRESH_CANDIDATE: 'owner-manual', COLLECTION_SESSION_MINUTES: '15' }), /fixed 25-minute/);
  assert.doesNotThrow(() => assertManualSelectedRequest({ SELECTED_REFRESH_CANDIDATE: 'owner-manual', COLLECTION_SESSION_MINUTES: '25' }));
});

test('target control admits only enabled non-rollback integer generations', () => {
  assert.equal(assertSelectedControl({ enabled: true, generation: 1, main12h_rollback: false }), 1);
  for (const control of [{ enabled: false, generation: 1, main12h_rollback: false }, { enabled: true, generation: 1, main12h_rollback: true }, { enabled: true, generation: 'bad', main12h_rollback: false }]) {
    assert.throws(() => assertSelectedControl(control), /disabled, rollback active, or generation invalid/);
  }
});

test('roulette payload matches the live owner/token/generation contract and found wraps fare', () => {
  assert.deepEqual(rouletteTicket(ticket), { observed_on: ticket.observed_on, origin: 'BER', snapshot_at: ticket.snapshot_at, dest: 'BCN', flight_type: 'any', departure_at: '2026-12-04', return_at: '2026-12-07', rank: 1 });
  const result = rouletteResult(ticket, { status: 'found', price: 99, source: { transfers: 1 } }, () => Date.parse('2026-11-05T06:00:00Z'));
  assert.equal(result.status, 'found'); assert.equal(result.fare.price, 99); assert.ok(result.fare.updated_at);
  assert.deepEqual(rouletteResult(ticket, { status: 'no_result' }), { status: 'no_result' });
});

test('carousel payload contains factual selected destination/date identity; no-result is confirmed_absent', () => {
  const identity = carouselTicket(ticket);
  assert.deepEqual(Object.keys(identity).sort(), ['departure_at', 'dest', 'destination_id', 'flight_type', 'observed_on', 'origin', 'return_at', 'snapshot_at']);
  const result = carouselResult(ticket, { status: 'no_result' });
  assert.equal(result.status, 'confirmed_absent'); assert.deepEqual(result.replacement, identity);
  const found = carouselResult(ticket, { status: 'found', price: 99, source: { transfers: 1 } }, () => Date.parse('2026-11-05T06:00:00Z'));
  assert.equal(found.status, 'found'); assert.deepEqual(found.replacement, identity); assert.equal(found.fare.price, 99);
});

test('manual selected runner contains no coordinator, MAIN, or daily-selection entry point', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./selected-refresh-recovery.mjs', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /runDueDailySelection|createAdapters|\.main\.step|snapshot-daily-/);
});
