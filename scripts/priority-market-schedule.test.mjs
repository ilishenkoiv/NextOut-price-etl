import test from 'node:test';
import assert from 'node:assert/strict';
import { localMinuteOfDay, dueForInterval, priorityMarketPolicy, originDueThisCycle, partitionTicketsByMarketSchedule } from './priority-market-schedule.mjs';
import { CYCLE_MS } from './collection-schedule.mjs';

// Berlin is UTC+1 (CET) in winter, UTC+2 (CEST) in summer.
const berlinWinter = (h, m) => Date.parse(`2026-01-15T${String(h - 1).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
const berlinSummer = (h, m) => Date.parse(`2026-07-15T${String(h - 2).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
const londonWinter = (h, m) => Date.parse(`2026-01-15T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`); // GMT=UTC in winter
const londonSummer = (h, m) => Date.parse(`2026-07-15T${String(h - 1).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`); // BST=UTC+1

test('localMinuteOfDay resolves correct local wall time across winter and summer (DST-safe via Intl)', () => {
  assert.equal(localMinuteOfDay(berlinWinter(19, 30), 'Europe/Berlin'), 19 * 60 + 30);
  assert.equal(localMinuteOfDay(berlinSummer(19, 30), 'Europe/Berlin'), 19 * 60 + 30);
  assert.equal(localMinuteOfDay(londonWinter(18, 0), 'Europe/London'), 18 * 60);
  assert.equal(localMinuteOfDay(londonSummer(18, 0), 'Europe/London'), 18 * 60);
});

test('DACH peak is 19:00-23:00 local; rest-of-Europe peak is 18:00-23:00 local, both DST-safe', () => {
  assert.equal(priorityMarketPolicy(berlinSummer(18, 59), 'FRA').phase, 'daytime'); // DACH: not yet peak
  assert.equal(priorityMarketPolicy(berlinSummer(19, 0), 'FRA').phase, 'peak');
  assert.equal(priorityMarketPolicy(berlinWinter(19, 0), 'FRA').phase, 'peak'); // same local clock in winter
  assert.equal(priorityMarketPolicy(londonSummer(17, 59), 'LHR').phase, 'daytime'); // non-DACH: peak starts an hour earlier
  assert.equal(priorityMarketPolicy(londonSummer(18, 0), 'LHR').phase, 'peak');
  assert.equal(priorityMarketPolicy(londonWinter(18, 0), 'LHR').phase, 'peak');
});

test('peak ends and night begins exactly at local 23:00, daytime resumes exactly at local 07:00', () => {
  assert.equal(priorityMarketPolicy(berlinSummer(22, 59), 'MUC').phase, 'peak');
  assert.equal(priorityMarketPolicy(berlinSummer(23, 0), 'MUC').phase, 'night');
  assert.equal(priorityMarketPolicy(berlinSummer(6, 59), 'MUC').phase, 'night');
  assert.equal(priorityMarketPolicy(berlinSummer(7, 0), 'MUC').phase, 'daytime');
  assert.equal(priorityMarketPolicy(londonSummer(17, 59), 'LHR').phase, 'daytime');
  assert.equal(priorityMarketPolicy(londonSummer(6, 59), 'LHR').phase, 'night');
  assert.equal(priorityMarketPolicy(londonSummer(7, 0), 'LHR').phase, 'daytime');
});

test('night phase (23:00-07:00 local) is mainOnly — no priority interval at all', () => {
  const midnight = priorityMarketPolicy(berlinSummer(2, 0), 'FRA');
  assert.equal(midnight.mainOnly, true);
  assert.equal(midnight.intervalMs, null);
  assert.equal(originDueThisCycle(berlinSummer(2, 0), 'FRA'), false);
});

test('daytime is a 2-hour cadence, peak is a 30-minute cadence', () => {
  assert.equal(priorityMarketPolicy(berlinSummer(10, 0), 'FRA').intervalMs, 2 * 60 * 60_000);
  assert.equal(priorityMarketPolicy(berlinSummer(20, 0), 'FRA').intervalMs, 30 * 60_000);
});

test('every origin (mapped or not) is explicitly marked approximate — only departure airport is known', () => {
  assert.equal(priorityMarketPolicy(berlinSummer(20, 0), 'FRA').approximate, true);
  assert.equal(priorityMarketPolicy(londonSummer(20, 0), 'LHR').approximate, true);
});

test('unmapped origin fails closed with a clear error (same contract as marketForOrigin elsewhere)', () => {
  assert.throws(() => priorityMarketPolicy(berlinSummer(20, 0), 'XXX'), /No Aviasales market configured/);
});

test('dueForInterval is cycle-aligned to the epoch: 30-minute interval fires every cycle, 2-hour interval every 4th', () => {
  const cycle0 = Math.floor(berlinSummer(10, 0) / CYCLE_MS) * CYCLE_MS;
  assert.equal(dueForInterval(cycle0, 30 * 60_000), true);
  assert.equal(dueForInterval(cycle0 + CYCLE_MS, 30 * 60_000), true);
  const due = [0, 1, 2, 3].map(n => dueForInterval(cycle0 + n * CYCLE_MS, 2 * 60 * 60_000));
  assert.equal(due.filter(Boolean).length, 1); // exactly one of every 4 consecutive 30-min cycles
});

test('dueForInterval rejects an interval that is not a multiple of CYCLE_MS (would silently drift)', () => {
  assert.throws(() => dueForInterval(Date.now(), 45 * 60_000), /multiple of CYCLE_MS/);
});

test('DST spring-forward (Europe/Berlin, last Sunday of March): clock skips 02:00->03:00, policy still resolves a valid single phase either side', () => {
  const before = Date.parse('2026-03-29T00:30:00Z'); // 01:30 CET
  const after = Date.parse('2026-03-29T01:30:00Z'); // 03:30 CEST (02:xx does not exist that day)
  const beforePolicy = priorityMarketPolicy(before, 'FRA');
  const afterPolicy = priorityMarketPolicy(after, 'FRA');
  assert.equal(beforePolicy.minute, 1 * 60 + 30);
  assert.equal(afterPolicy.minute, 3 * 60 + 30);
  assert.equal(beforePolicy.phase, 'night');
  assert.equal(afterPolicy.phase, 'night');
});

test('DST fall-back (Europe/Berlin, last Sunday of October): the repeated 02:00-03:00 hour still classifies correctly on both sides of the UTC instant', () => {
  const firstPass = Date.parse('2026-10-25T00:30:00Z'); // 02:30 CEST (first occurrence)
  const secondPass = Date.parse('2026-10-25T01:30:00Z'); // 02:30 CET (second occurrence, same wall clock)
  const p1 = priorityMarketPolicy(firstPass, 'FRA');
  const p2 = priorityMarketPolicy(secondPass, 'FRA');
  assert.equal(p1.minute, 2 * 60 + 30);
  assert.equal(p2.minute, 2 * 60 + 30);
  assert.equal(p1.phase, 'night'); // both readings of the repeated wall-clock hour agree: still night
  assert.equal(p2.phase, 'night');
});

test('partitionTicketsByMarketSchedule keeps not-due tickets out of this cycle without dropping them', () => {
  const instant = berlinSummer(2, 0); // night for every mapped market below
  const tickets = [{ origin: 'FRA', id: 1 }, { origin: 'LHR', id: 2 }];
  const { due, notDue } = partitionTicketsByMarketSchedule(instant, tickets);
  assert.deepEqual(due, []);
  assert.equal(notDue.length, 2);
});
