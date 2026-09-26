import { test } from 'node:test';
import assert from 'node:assert/strict';
import { variantCheckedAtPatch } from './price-variant-timestamps.mjs';

const NOW = '2026-09-26T12:00:00.000Z';

test('direct-only: only direct answered → stamps direct_checked_at only', () => {
  const patch = variantCheckedAtPatch(new Set(['direct']), NOW);
  assert.deepEqual(patch, { direct_checked_at: NOW });
});

test('any-only: only any answered → stamps any_checked_at only', () => {
  const patch = variantCheckedAtPatch(new Set(['any']), NOW);
  assert.deepEqual(patch, { any_checked_at: NOW });
});

test('mixed success/failure: natural type confirmed empty, alt type refused this cycle → only the answered type is stamped', () => {
  // Mirrors fetch-prices.mjs: naturalType added to `answered` on its own ok response (even
  // min:null); altType is added only if ITS OWN probe was ok — an outright refusal never adds it.
  const answered = new Set(['direct']); // 'any' probe refused/timed out this cycle, not added
  const patch = variantCheckedAtPatch(answered, NOW);
  assert.deepEqual(patch, { direct_checked_at: NOW });
});

test('both genuinely observed this cycle (alt closed an empty natural cell): stamps both', () => {
  const patch = variantCheckedAtPatch(new Set(['direct', 'any']), NOW);
  assert.deepEqual(patch, { direct_checked_at: NOW, any_checked_at: NOW });
});

test('empty answered set → empty patch (pure-function contract; in fetch-prices.mjs an entirely-carried/failed cell never reaches this call at all — see fetch-prices.test.cjs)', () => {
  const patch = variantCheckedAtPatch(new Set(), NOW);
  assert.deepEqual(patch, {});
});
