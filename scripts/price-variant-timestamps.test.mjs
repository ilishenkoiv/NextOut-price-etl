import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildVariantPriceRow } from './price-variant-timestamps.mjs';

const NOW = '2026-09-26T12:00:00.000Z';
const OLD_DIRECT_AT = '2026-09-20T03:00:00.000Z';
const OLD_ANY_AT = '2026-09-18T03:00:00.000Z';
const prevBoth = { direct: 150, any_stops: 300, direct_checked_at: OLD_DIRECT_AT, any_checked_at: OLD_ANY_AT };

test('successful priced check: direct answered with a real price → updates fare AND timestamp', () => {
  const row = buildVariantPriceRow(new Set(['direct']), { direct: 99 }, NOW, prevBoth);
  assert.equal(row.direct, 99);
  assert.equal(row.direct_checked_at, NOW);
});

test('confirmed no-fare: direct answered with min:null → clears ONLY direct\'s fare, still stamps its checked_at (a real observation)', () => {
  const row = buildVariantPriceRow(new Set(['direct']), { direct: null }, NOW, prevBoth);
  assert.equal(row.direct, null);
  assert.equal(row.direct_checked_at, NOW);
  // The sibling is untouched by this same call — proven in the next tests.
});

test('failed/untouched sibling (any not in answered): retains BOTH its baseline fare and its baseline timestamp, never cleared, never freshened', () => {
  const row = buildVariantPriceRow(new Set(['direct']), { direct: 99 }, NOW, prevBoth);
  assert.equal(row.any_stops, 300);
  assert.equal(row.any_checked_at, OLD_ANY_AT);
});

test('mixed batch shape (both types answered this cycle): each gets its OWN fare and now-timestamp, independent of the other', () => {
  const row = buildVariantPriceRow(new Set(['direct', 'any']), { direct: 120, any: null }, NOW, prevBoth);
  assert.deepEqual(row, { direct: 120, direct_checked_at: NOW, any_stops: null, any_checked_at: NOW });
});

test('brand-new row, no prev at all: unanswered variant is null fare + null timestamp, not prev-shaped garbage', () => {
  const row = buildVariantPriceRow(new Set(['direct']), { direct: 500 }, NOW, undefined);
  assert.deepEqual(row, { direct: 500, direct_checked_at: NOW, any_stops: null, any_checked_at: null });
});

test('nothing answered this cycle (defensive — fetch-prices.mjs never reaches this call in that case, see fetch-prices.test.cjs): both columns fully carried forward, neither cleared nor freshened', () => {
  const row = buildVariantPriceRow(new Set(), {}, NOW, prevBoth);
  assert.deepEqual(row, { direct: 150, direct_checked_at: OLD_DIRECT_AT, any_stops: 300, any_checked_at: OLD_ANY_AT });
});

test('always returns all four keys explicitly — never omits one (the batch-upsert safety property; see prices-upsert-request.test.mjs)', () => {
  for (const answered of [new Set(), new Set(['direct']), new Set(['any']), new Set(['direct', 'any'])]) {
    const row = buildVariantPriceRow(answered, { direct: 1, any: 2 }, NOW, prevBoth);
    for (const key of ['direct', 'direct_checked_at', 'any_stops', 'any_checked_at']) {
      assert.ok(Object.prototype.hasOwnProperty.call(row, key), `missing ${key}`);
    }
  }
});
