import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarMonthsAgoIso, DESTINATION_REQUEST_RETENTION_MONTHS } from './destination-request-retention.mjs';

test('destination requests retain exactly 24 calendar months', () => {
  assert.equal(DESTINATION_REQUEST_RETENTION_MONTHS, 24);
  assert.equal(
    calendarMonthsAgoIso('2028-08-29T10:11:12.345Z'),
    '2026-08-29T10:11:12.345Z',
  );
});

test('calendar cutoff clamps leap day to the last target-month day', () => {
  assert.equal(
    calendarMonthsAgoIso('2028-02-29T09:00:00.000Z'),
    '2026-02-28T09:00:00.000Z',
  );
});

test('calendar cutoff rejects invalid inputs', () => {
  assert.throws(() => calendarMonthsAgoIso('not-a-date'), /valid date/);
  assert.throws(() => calendarMonthsAgoIso('2026-08-29T00:00:00.000Z', 0), /positive integer/);
  assert.throws(() => calendarMonthsAgoIso('2026-08-29T00:00:00.000Z', 2.5), /positive integer/);
});
