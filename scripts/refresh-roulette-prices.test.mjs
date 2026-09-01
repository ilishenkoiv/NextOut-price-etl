import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTicketUrl, selectExactFare, ticketKey } from './refresh-roulette-prices.mjs';

const ticket = {
  origin: 'BER', dest: 'PMI', flight_type: 'direct',
  departure_at: '2026-10-10', return_at: '2026-10-17',
};

test('selectExactFare ignores other dates and keeps the cheapest exact result', () => {
  const fare = selectExactFare([
    { departure_at:'2026-10-10', return_at:'2026-10-18', price:40, transfers:0 },
    { departure_at:'2026-10-10T08:00:00Z', return_at:'2026-10-17T20:00:00Z', price:75, transfers:0, airline:'AB' },
    { departure_at:'2026-10-10', return_at:'2026-10-17', price:69.6, transfers:1, airline:'CD' },
  ], ticket);
  assert.deepEqual(fare, { price:70, transfers:1, airline:'CD' });
});

test('selectExactFare returns null for a successful response without the promised ticket', () => {
  assert.equal(selectExactFare([
    { departure_at:'2026-10-11', return_at:'2026-10-17', price:50 },
  ], ticket), null);
});

test('ticket request pins exact dates and stop mode', () => {
  const url = new URL(buildTicketUrl(ticket, 'secret token'));
  assert.equal(url.searchParams.get('origin'), 'BER');
  assert.equal(url.searchParams.get('destination'), 'PMI');
  assert.equal(url.searchParams.get('departure_at'), '2026-10-10');
  assert.equal(url.searchParams.get('return_at'), '2026-10-17');
  assert.equal(url.searchParams.get('direct'), 'true');
  assert.equal(url.searchParams.get('token'), 'secret token');
  assert.equal(ticketKey(ticket), 'BER|PMI|direct|2026-10-10|2026-10-17');
});
