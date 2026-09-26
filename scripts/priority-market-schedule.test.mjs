import test from 'node:test';
import assert from 'node:assert/strict';
import { localMinuteOfDay, localWeekday, dueForInterval, priorityMarketPolicy, originDueThisCycle, partitionTicketsByMarketSchedule } from './priority-market-schedule.mjs';
import { CYCLE_MS } from './collection-schedule.mjs';
import { readFileSync } from 'node:fs';

// Berlin is UTC+1 (CET) in winter, UTC+2 (CEST) in summer.
// 2026-09-14 is a Monday, 2026-09-19 a Saturday, 2026-09-20 a Sunday — all before the Oct DST switch (CEST, UTC+2).
const berlin = (dateIso, h, m) => Date.parse(`${dateIso}T${String(h - 2).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
const monday = (h, m) => berlin('2026-09-14', h, m);
const saturday = (h, m) => berlin('2026-09-19', h, m);
const sunday = (h, m) => berlin('2026-09-20', h, m);

test('localMinuteOfDay resolves correct local wall time across winter and summer (DST-safe via Intl)', () => {
  assert.equal(localMinuteOfDay(monday(19, 30), 'Europe/Berlin'), 19 * 60 + 30);
  assert.equal(localMinuteOfDay(Date.parse('2026-01-15T18:30:00Z'), 'Europe/Berlin'), 19 * 60 + 30); // CET, UTC+1
});

test('localWeekday resolves 0=Sunday..6=Saturday in the given timezone, DST-safe', () => {
  assert.equal(localWeekday(monday(12, 0)), 1);
  assert.equal(localWeekday(saturday(12, 0)), 6);
  assert.equal(localWeekday(sunday(12, 0)), 0);
});

// --- Cadence table: Mon-Sat -------------------------------------------------
for (const day of [['Monday', monday], ['Saturday', saturday]]) {
  const [label, at] = day;
  test(`${label}: 07:00-18:00 daytime (2h), 18:00-23:00 evening (30min), 23:00-07:00 night (off)`, () => {
    assert.deepEqual(pick(priorityMarketPolicy(at(6, 59), 'FRA')), { phase: 'night', intervalMs: null, mainOnly: true });
    assert.deepEqual(pick(priorityMarketPolicy(at(7, 0), 'FRA')), { phase: 'daytime', intervalMs: 2 * 60 * 60_000, mainOnly: false });
    assert.deepEqual(pick(priorityMarketPolicy(at(17, 59), 'FRA')), { phase: 'daytime', intervalMs: 2 * 60 * 60_000, mainOnly: false });
    assert.deepEqual(pick(priorityMarketPolicy(at(18, 0), 'FRA')), { phase: 'evening', intervalMs: 30 * 60_000, mainOnly: false });
    assert.deepEqual(pick(priorityMarketPolicy(at(22, 59), 'FRA')), { phase: 'evening', intervalMs: 30 * 60_000, mainOnly: false });
    assert.deepEqual(pick(priorityMarketPolicy(at(23, 0), 'FRA')), { phase: 'night', intervalMs: null, mainOnly: true });
  });
}

// --- Cadence table: Sunday --------------------------------------------------
test('Sunday: 07:00-14:00 daytime (2h), 14:00-23:00 evening (60min), 23:00-07:00 night (off)', () => {
  assert.deepEqual(pick(priorityMarketPolicy(sunday(6, 59), 'FRA')), { phase: 'night', intervalMs: null, mainOnly: true });
  assert.deepEqual(pick(priorityMarketPolicy(sunday(7, 0), 'FRA')), { phase: 'daytime', intervalMs: 2 * 60 * 60_000, mainOnly: false });
  assert.deepEqual(pick(priorityMarketPolicy(sunday(13, 59), 'FRA')), { phase: 'daytime', intervalMs: 2 * 60 * 60_000, mainOnly: false });
  assert.deepEqual(pick(priorityMarketPolicy(sunday(14, 0), 'FRA')), { phase: 'evening', intervalMs: 60 * 60_000, mainOnly: false });
  assert.deepEqual(pick(priorityMarketPolicy(sunday(22, 59), 'FRA')), { phase: 'evening', intervalMs: 60 * 60_000, mainOnly: false });
  assert.deepEqual(pick(priorityMarketPolicy(sunday(23, 0), 'FRA')), { phase: 'night', intervalMs: null, mainOnly: true });
});

function pick(policy) { return { phase: policy.phase, intervalMs: policy.intervalMs, mainOnly: policy.mainOnly }; }

test('night phase (23:00-07:00 local, every day) is mainOnly — no priority interval at all', () => {
  const midnight = priorityMarketPolicy(monday(2, 0), 'FRA');
  assert.equal(midnight.mainOnly, true);
  assert.equal(midnight.intervalMs, null);
  assert.equal(originDueThisCycle(monday(2, 0), 'FRA'), false);
});

test('origin is accepted but does not affect the policy — one shared Europe/Berlin clock for every origin', () => {
  assert.deepEqual(pick(priorityMarketPolicy(monday(20, 0), 'FRA')), pick(priorityMarketPolicy(monday(20, 0), 'HND')));
});

test('dueForInterval is cycle-aligned to the epoch: 30-minute interval fires every cycle, 2-hour interval every 4th', () => {
  const cycle0 = Math.floor(monday(10, 0) / CYCLE_MS) * CYCLE_MS;
  assert.equal(dueForInterval(cycle0, 30 * 60_000), true);
  assert.equal(dueForInterval(cycle0 + CYCLE_MS, 30 * 60_000), true);
  const due = [0, 1, 2, 3].map(n => dueForInterval(cycle0 + n * CYCLE_MS, 2 * 60 * 60_000));
  assert.equal(due.filter(Boolean).length, 1); // exactly one of every 4 consecutive 30-min cycles
});

test('dueForInterval rejects a non-numeric instant explicitly instead of silently returning false', () => {
  assert.throws(() => dueForInterval(NaN, 30 * 60_000), /Invalid instant/);
  assert.throws(() => dueForInterval(undefined, 30 * 60_000), /Invalid instant/);
  assert.throws(() => dueForInterval('not-a-number', 30 * 60_000), /Invalid instant/);
});

test('dueForInterval rejects an interval that is not a multiple of CYCLE_MS (would silently drift)', () => {
  assert.throws(() => dueForInterval(Date.now(), 45 * 60_000), /multiple of CYCLE_MS/);
});

test('DST spring-forward 2027-03-28 (Europe/Berlin): clock skips 02:00->03:00, policy still resolves a valid single phase either side', () => {
  const before = Date.parse('2027-03-28T00:30:00Z'); // 01:30 CET, a Sunday
  const after = Date.parse('2027-03-28T01:30:00Z'); // 03:30 CEST (02:xx does not exist that day)
  const beforePolicy = priorityMarketPolicy(before, 'FRA');
  const afterPolicy = priorityMarketPolicy(after, 'FRA');
  assert.equal(beforePolicy.minute, 1 * 60 + 30);
  assert.equal(afterPolicy.minute, 3 * 60 + 30);
  assert.equal(beforePolicy.phase, 'night');
  assert.equal(afterPolicy.phase, 'night');
  assert.equal(beforePolicy.sunday, true);
});

test('DST fall-back 2026-10-25 (Europe/Berlin): the repeated 02:00-03:00 hour still classifies correctly on both sides of the UTC instant', () => {
  const firstPass = Date.parse('2026-10-25T00:30:00Z'); // 02:30 CEST (first occurrence), a Sunday
  const secondPass = Date.parse('2026-10-25T01:30:00Z'); // 02:30 CET (second occurrence, same wall clock)
  const p1 = priorityMarketPolicy(firstPass, 'FRA');
  const p2 = priorityMarketPolicy(secondPass, 'FRA');
  assert.equal(p1.minute, 2 * 60 + 30);
  assert.equal(p2.minute, 2 * 60 + 30);
  assert.equal(p1.phase, 'night'); // both readings of the repeated wall-clock hour agree: still night
  assert.equal(p2.phase, 'night');
  assert.equal(p1.sunday, true);
});

test('partitionTicketsByMarketSchedule keeps not-due tickets out of this cycle without dropping them', () => {
  const instant = monday(2, 0); // night — off for every origin
  const tickets = [{ origin: 'FRA', id: 1 }, { origin: 'LHR', id: 2 }];
  const { due, notDue } = partitionTicketsByMarketSchedule(instant, tickets);
  assert.deepEqual(due, []);
  assert.equal(notDue.length, 2);
});

test('the evening window is documented as a search/discovery-based pilot, never claimed as a proven purchase peak', () => {
  const source = readFileSync(new URL('./priority-market-schedule.mjs', import.meta.url), 'utf8');
  assert.match(source, /PILOT CAVEAT/);
  assert.match(source, /search\/discovery[\s\S]{0,20}activity patterns/);
  assert.match(source, /NOT a measured or proven[\s\S]{0,20}purchase peak/);
});
