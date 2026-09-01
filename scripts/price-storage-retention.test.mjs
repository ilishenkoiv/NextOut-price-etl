import test from 'node:test';
import assert from 'node:assert/strict';
import { positiveDays, retentionCutoff, shouldDeleteSnapshot, snapshotDateFromKey } from './price-storage-retention.mjs';

test('retention cutoff is calendar-safe across leap day', () => {
  assert.equal(retentionCutoff('2028-03-01', 365), '2027-03-02');
  assert.equal(retentionCutoff('2028-03-01', 1), '2028-02-29');
});

test('snapshot parser accepts only canonical dated snapshot objects', () => {
  assert.equal(snapshotDateFromKey('snapshots/2026/08/2026-08-28_1630_both.csv.gz'), '2026-08-28');
  assert.equal(snapshotDateFromKey('snapshots/2026/07/2026-08-28_1630_both.csv.gz'), null);
  assert.equal(snapshotDateFromKey('snapshots/2026/08/readme.txt'), null);
  assert.equal(snapshotDateFromKey('other/2026/08/2026-08-28_1630_both.csv.gz'), null);
});

test('cleanup is strict: cutoff-day and newer snapshots remain', () => {
  const cutoff = '2025-08-28';
  assert.equal(shouldDeleteSnapshot('snapshots/2025/08/2025-08-27_2300_both.csv.gz', cutoff), true);
  assert.equal(shouldDeleteSnapshot('snapshots/2025/08/2025-08-28_2300_both.csv.gz', cutoff), false);
  assert.equal(shouldDeleteSnapshot('snapshots/2026/08/2026-08-28_2300_both.csv.gz', cutoff), false);
});

test('retention overrides reject unsafe values', () => {
  assert.equal(positiveDays('', 365), 365);
  assert.equal(positiveDays('90', 365), 90);
  assert.throws(() => positiveDays('0', 365));
  assert.throws(() => positiveDays('2.5', 365));
});
