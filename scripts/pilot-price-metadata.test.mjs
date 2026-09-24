import test from 'node:test';
import assert from 'node:assert/strict';
import { computePilotState, publishPilotState, PRICE_FRESHNESS_APPROVED_MAX_MS } from './pilot-price-metadata.mjs';

test('the approved ceiling is exactly 120 minutes (docs/owner/TICKET-PRICE-POLICY-2026-09-24.md)', () => {
  assert.equal(PRICE_FRESHNESS_APPROVED_MAX_MS, 120 * 60 * 1000);
});

test('pilot ON: PRIORITY_MARKET_SCHEDULE=pilot reflects as pilot_active=true', () => {
  assert.deepEqual(computePilotState({ PRIORITY_MARKET_SCHEDULE: 'pilot' }),
    { pilot_active: true, price_freshness_ms: PRICE_FRESHNESS_APPROVED_MAX_MS });
});

test('pilot OFF: unset, empty, or any non-"pilot" value returns the legacy state — never merely "code is deployed"', () => {
  for (const env of [{}, { PRIORITY_MARKET_SCHEDULE: '' }, { PRIORITY_MARKET_SCHEDULE: 'off' },
    { PRIORITY_MARKET_SCHEDULE: 'PILOT' }, { PRIORITY_MARKET_SCHEDULE: 'pilot ' }]) {
    assert.equal(computePilotState(env).pilot_active, false, `expected legacy state for ${JSON.stringify(env)}`);
  }
});

test('missing/invalid metadata: an undefined env object still returns a well-formed legacy contract, never throws', () => {
  assert.deepEqual(computePilotState(), { pilot_active: false, price_freshness_ms: PRICE_FRESHNESS_APPROVED_MAX_MS });
});

test('the 120-minute ceiling is identical whether pilot is on or off — it is a fixed policy value, not derived from cadence', () => {
  const on = computePilotState({ PRIORITY_MARKET_SCHEDULE: 'pilot' });
  const off = computePilotState({});
  assert.equal(on.price_freshness_ms, off.price_freshness_ms);
});

test('a stricter requested ceiling is honored; a looser one is clamped down and never published', () => {
  assert.equal(computePilotState({}, { requestedFreshnessMs: 30 * 60 * 1000 }).price_freshness_ms, 30 * 60 * 1000, 'stricter is allowed through');
  assert.equal(computePilotState({}, { requestedFreshnessMs: 999 * 60 * 1000 }).price_freshness_ms, PRICE_FRESHNESS_APPROVED_MAX_MS, 'looser is capped, never exceeds the owner-approved ceiling');
});

test('invalid requested ceiling (zero, negative, NaN) fails loud instead of silently defaulting', () => {
  for (const bad of [0, -1, NaN, Infinity]) assert.throws(() => computePilotState({}, { requestedFreshnessMs: bad }), /Invalid requested price freshness/);
});

test('market time boundaries and daily epoch changes never affect the published contract — it has no time-of-day or day-boundary input at all', () => {
  // Regression guard: this contract must stay decoupled from originDueThisCycle/day-boundary logic.
  // Same env, four different instants spanning a DST boundary and a day rollover -> identical output.
  const instants = [
    Date.parse('2026-01-15T01:00:00Z'),  // night, mainOnly
    Date.parse('2026-01-15T19:00:00Z'),  // DACH peak
    Date.parse('2026-03-29T00:30:00Z'),  // DST spring-forward boundary (Europe/Berlin)
    Date.parse('2026-01-16T00:00:00Z'),  // day rollover
  ];
  const results = instants.map(clock => { void clock; return computePilotState({ PRIORITY_MARKET_SCHEDULE: 'pilot' }); });
  for (const r of results) assert.deepEqual(r, results[0]);
});

test('publishPilotState upserts exactly one global-scope row with a fresh timestamp, under the caller\'s own db client — no lease of its own', async () => {
  const upserts = [];
  const db = { from: table => ({ upsert: async (row, opts) => { upserts.push({ table, row, opts }); return { error: null }; } }) };
  const state = await publishPilotState(db, { PRIORITY_MARKET_SCHEDULE: 'pilot' }, { clock: () => Date.parse('2026-09-24T12:00:00Z') });
  assert.equal(upserts.length, 1);
  assert.equal(upserts[0].table, 'collection_pilot_state');
  assert.deepEqual(upserts[0].row, { scope: 'global', pilot_active: true, price_freshness_ms: PRICE_FRESHNESS_APPROVED_MAX_MS, updated_at: '2026-09-24T12:00:00.000Z' });
  assert.deepEqual(upserts[0].opts, { onConflict: 'scope' });
  assert.deepEqual(state, { pilot_active: true, price_freshness_ms: PRICE_FRESHNESS_APPROVED_MAX_MS });
});

test('publishPilotState fails loud on a database error instead of silently leaving stale metadata published', async () => {
  const db = { from: () => ({ upsert: async () => ({ error: { message: 'permission denied' } }) }) };
  await assert.rejects(() => publishPilotState(db, {}), /Failed to publish pilot state: permission denied/);
});
