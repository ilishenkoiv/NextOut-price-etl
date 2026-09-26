import test from 'node:test';
import assert from 'node:assert/strict';
import { maintenanceDue, maintenanceMustStop, berlinDay, isQuarterlyMaintenanceDay,
  MAINTENANCE_DUE_MINUTES, MAINTENANCE_STOP_BY_MINUTES, MAINTENANCE_BLOCK_MAX_MS } from './maintenance-window.mjs';

const berlinWinter = (h, m) => Date.parse(`2026-01-15T${String(h - 1).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`); // CET, UTC+1

test('constants: due 03:00, stop-by 05:45, 15-minute cap', () => {
  assert.equal(MAINTENANCE_DUE_MINUTES, 3 * 60);
  assert.equal(MAINTENANCE_STOP_BY_MINUTES, 5 * 60 + 45);
  assert.equal(MAINTENANCE_BLOCK_MAX_MS, 15 * 60_000);
});

test('due exactly at 03:00, not at 02:59', () => {
  assert.equal(maintenanceDue(berlinWinter(2, 59), null), false);
  assert.equal(maintenanceDue(berlinWinter(3, 0), null), true);
});

test('once per Berlin day: not due again once blockDone for today, due again once the day changes', () => {
  const day = berlinDay(berlinWinter(3, 30));
  assert.equal(maintenanceDue(berlinWinter(3, 30), { day, blockDone: true }), false);
  assert.equal(maintenanceDue(berlinWinter(3, 30), { day, blockDone: false }), true);
  const nextDay = berlinDay(berlinWinter(3, 30) + 86400000);
  assert.notEqual(day, nextDay);
  assert.equal(maintenanceDue(Date.parse('2026-01-16T02:30:00Z'), { day, blockDone: true }), true); // new Berlin day
});

test('not due after 05:45 (must have stopped by then)', () => {
  assert.equal(maintenanceDue(berlinWinter(5, 44), null), true);
  assert.equal(maintenanceDue(berlinWinter(5, 45), null), false);
});

test('DST spring-forward 2027-03-28 (Europe/Berlin): clock skips 02:00->03:00 straight to due', () => {
  const before = Date.parse('2027-03-28T00:59:00Z'); // 01:59 CET, last instant before the jump
  const after = Date.parse('2027-03-28T01:00:00Z');  // 03:00 CEST (02:xx does not exist that day)
  assert.equal(maintenanceDue(before, null), false);
  assert.equal(maintenanceDue(after, null), true);
});

test('DST fall-back 2026-10-25 (Europe/Berlin): the repeated 02:xx hour is not-yet-due both times, 03:00 is due', () => {
  const firstPass = Date.parse('2026-10-25T00:30:00Z');  // 02:30 CEST (first occurrence)
  const secondPass = Date.parse('2026-10-25T01:30:00Z'); // 02:30 CET (second occurrence, same wall clock)
  const atThreshold = Date.parse('2026-10-25T02:00:00Z'); // 03:00 (single, unambiguous occurrence)
  assert.equal(maintenanceDue(firstPass, null), false);
  assert.equal(maintenanceDue(secondPass, null), false);
  assert.equal(maintenanceDue(atThreshold, null), true);
});

test('must stop once the 15-minute block budget is spent, even before 05:45', () => {
  assert.equal(maintenanceMustStop(berlinWinter(3, 10), 14 * 60_000), false);
  assert.equal(maintenanceMustStop(berlinWinter(3, 10), 15 * 60_000), true);
});

test('must stop at 05:45 regardless of remaining budget', () => {
  assert.equal(maintenanceMustStop(berlinWinter(5, 45), 0), true);
  assert.equal(maintenanceMustStop(berlinWinter(5, 44), 0), false);
});

test('isQuarterlyMaintenanceDay matches the standalone workflow cron (1 1,4,7,10 *)', () => {
  for (const ymd of ['2026-01-01', '2026-04-01', '2026-07-01', '2026-10-01']) assert.equal(isQuarterlyMaintenanceDay(ymd), true);
  for (const ymd of ['2026-01-02', '2026-02-01', '2026-12-01', 'not-a-date']) assert.equal(isQuarterlyMaintenanceDay(ymd), false);
});
