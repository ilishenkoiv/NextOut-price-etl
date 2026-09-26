import test from 'node:test';
import assert from 'node:assert/strict';
import { pointRefreshTickets, ticketKey } from './daily-selection-refresh.mjs';

const ticket = { origin: 'BER', dest: 'BCN', flight_type: 'any', departure_at: '2027-01-10', return_at: '2027-01-17', transfers: 1 };
const secondTicket = { origin: 'FRA', dest: 'MAD', flight_type: 'direct', departure_at: '2027-02-01', return_at: '2027-02-08', transfers: 0 };

test('ticketKey identifies a ticket by its exact route/date/mode identity', () => {
  assert.equal(ticketKey(ticket), 'BER|BCN|any|2027-01-10|2027-01-17');
});

test('a found response confirms price/transfers/airline and stamps price provenance', async () => {
  const provider = { request: async () => ({ kind: 'ok', json: { success: true,
    data: [{ departure_at: '2027-01-10', return_at: '2027-01-17', price: 88, transfers: 0, airline: 'AB' }] } }) };
  const { confirmed, refreshed, misses, errors, attempted, total } = await pointRefreshTickets([ticket], { provider, deadline: Infinity });
  assert.equal(refreshed, 1); assert.equal(misses, 0); assert.equal(errors, 0); assert.equal(attempted, 1); assert.equal(total, 1);
  const c = confirmed.get(ticketKey(ticket));
  assert.equal(c.price, 88); assert.equal(c.transfers, 0); assert.equal(c.airline, 'AB');
  assert.equal(c.price_source.table, 'offers');
});

test('an empty (no_result) response is counted as a miss and never appears in confirmed', async () => {
  const provider = { request: async () => ({ kind: 'ok', json: { success: true, data: [] } }) };
  const { confirmed, misses, refreshed } = await pointRefreshTickets([ticket], { provider, deadline: Infinity });
  assert.equal(misses, 1); assert.equal(refreshed, 0); assert.equal(confirmed.size, 0);
});

test('a provider refusal/error is counted as an error, distinct from a miss', async () => {
  const provider = { request: async () => ({ kind: 'refused', refusal: 'server' }) };
  const { errors, misses, confirmed } = await pointRefreshTickets([ticket], { provider, deadline: Infinity });
  assert.equal(errors, 1); assert.equal(misses, 0); assert.equal(confirmed.size, 0);
});

test('sequential: one provider request per ticket, in order, never a bulk read', async () => {
  const urls = [];
  const provider = { request: async (url) => { urls.push(String(url)); return { kind: 'ok', json: { success: true, data: [] } }; } };
  await pointRefreshTickets([ticket, secondTicket], { provider, deadline: Infinity });
  assert.equal(urls.length, 2);
  assert.match(urls[0], /origin=BER.*destination=BCN|destination=BCN.*origin=BER/);
  assert.match(urls[1], /origin=FRA.*destination=MAD|destination=MAD.*origin=FRA/);
  for (const url of urls) assert.match(url, /^https:\/\/api\.travelpayouts\.com\/aviasales\/v3\/prices_for_dates\?/);
});

test('a ticket reached after the deadline is simply never attempted (neither confirmed nor missed)', async () => {
  let requests = 0;
  const provider = { request: async () => { requests++; return { kind: 'ok', json: { success: true, data: [] } }; } };
  const clock = () => 1_000_000;
  const result = await pointRefreshTickets([ticket, secondTicket], { provider, clock, deadline: 1_000_000 + 8000 });
  assert.equal(requests, 0, 'the 9s safety margin means nothing is attempted this close to the deadline');
  assert.equal(result.attempted, 0); assert.equal(result.total, 2);
});
