// scripts/break-windows.test.mjs — behavioural tests for the rewritten break-window schemes.
// Unit-testable because break-windows.mjs is pure (no import-time side effects), unlike
// fetch-prices.mjs which starts main() on import. RUNNER: node:test (`npm test` → `node --test`).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBreakWindows, buildBlocks, addDaysIso, dowUtc, MAX_WINDOW_NIGHTS,
} from './break-windows.mjs';

// The keySet holds `${departure}|${nights}`. Helpers to assert on it.
const build = (holidays, from, to) => buildBreakWindows(new Set(holidays), from, to);
const has = (res, dep, nights) => res.keySet.has(`${dep}|${nights}`);
// First iso ≥ start whose weekday is `dow` (0=Sun … 6=Sat) — lets scheme tests avoid hardcoded weekdays.
const onDow = (start, dow) => { let d = start; while (dowUtc(d) !== dow) d = addDaysIso(d, 1); return d; };

// A wide horizon so no scheme window is filtered for departing out of range.
const FROM = '2026-11-01', TO = '2027-02-28';

describe('short window by weekday (single-day block)', () => {
  it('Monday → Fri→Mon (3n)', () => {
    const mon = onDow('2026-11-16', 1);
    assert.ok(has(build([mon], FROM, TO), addDaysIso(mon, -3), 3));
  });
  it('Tuesday → Fri→Tue (4n)', () => {
    const tue = onDow('2026-11-16', 2);
    assert.ok(has(build([tue], FROM, TO), addDaysIso(tue, -4), 4));
  });
  it('Wednesday → BOTH Tue→Sun (5n) and Fri→Wed (5n)', () => {
    const wed = onDow('2026-11-16', 3);
    const res = build([wed], FROM, TO);
    assert.ok(has(res, addDaysIso(wed, -1), 5), 'Tue→Sun');
    assert.ok(has(res, addDaysIso(wed, -5), 5), 'Fri→Wed');
  });
  it('Thursday → Wed→Sun (4n), and NOT the old Thu→Mon', () => {
    const thu = onDow('2026-11-16', 4);
    const res = build([thu], FROM, TO);
    assert.ok(has(res, addDaysIso(thu, -1), 4), 'Wed→Sun present');
    assert.ok(!has(res, thu, 4), 'old Thu→Mon (departs Thursday, returns a workday) is gone');
  });
  it('Friday → Thu→Sun (3n), and NOT the old Fri→Mon', () => {
    const fri = onDow('2026-11-16', 5);
    const res = build([fri], FROM, TO);
    assert.ok(has(res, addDaysIso(fri, -1), 3), 'Thu→Sun present');
    assert.ok(!has(res, fri, 3), 'old Fri→Mon (returns a workday) is gone');
  });
  it('Saturday-only holiday gives NO short window of its own', () => {
    const sat = onDow('2026-11-16', 6);
    const res = build([sat], FROM, TO);
    assert.equal(res.short, 0);
  });
});

describe('склейка — holidays with only weekends between merge into one block', () => {
  it('adjacent holidays merge (Fri + Sat → one block)', () => {
    assert.deepEqual(buildBlocks(['2026-12-25', '2026-12-26']), [{ first: '2026-12-25', last: '2026-12-26' }]);
  });
  it('holidays split by a weekend merge (Fri + Mon → one block)', () => {
    // 2026-12-25 Fri, 2026-12-28 Mon; between them only Sat/Sun.
    assert.deepEqual(buildBlocks(['2026-12-25', '2026-12-28']), [{ first: '2026-12-25', last: '2026-12-28' }]);
  });
  it('holidays split by a workday stay separate', () => {
    // 2026-12-25 Fri, 2026-12-30 Wed; 28 Mon & 29 Tue are workdays.
    assert.deepEqual(buildBlocks(['2026-12-25', '2026-12-30']),
      [{ first: '2026-12-25', last: '2026-12-25' }, { first: '2026-12-30', last: '2026-12-30' }]);
  });
});

describe('vacation windows — up to four per block', () => {
  it('a Tuesday holiday yields the four start×return combos (deduped, within ceiling)', () => {
    const tue = onDow('2026-11-16', 2); // isolated holiday, no other holidays around
    const res = build([tue], FROM, TO);
    assert.ok(res.vacation >= 1 && res.vacation <= 4);
  });
});

describe('connect two blocks ≤7 days apart — closes Christmas with no special code', () => {
  const res = build(['2026-12-25', '2026-12-26', '2027-01-01'], '2026-12-01', '2027-01-31');
  it('produces the Dec 24 → Jan 2 span (9 nights)', () => {
    assert.ok(has(res, '2026-12-24', 9), 'Dec24→Jan2 connecting window present');
    assert.ok(res.connecting >= 1);
  });
  it('never exceeds the 14-night ceiling (long Christmas spans dropped)', () => {
    for (const key of res.keySet) {
      const nights = Number(key.split('|')[1]);
      assert.ok(nights >= 1 && nights <= MAX_WINDOW_NIGHTS, `window ${key} outside 1..${MAX_WINDOW_NIGHTS}`);
    }
  });
});

describe('ordinary weekends and bookkeeping', () => {
  it('a plain Friday gives Fri→Sun (2n)', () => {
    const fri = onDow('2026-11-06', 5);
    // No holidays at all → only weekend windows.
    const res = build([], FROM, TO);
    assert.ok(has(res, fri, 2));
    assert.ok(res.weekend > 0);
  });
  it('the per-kind counts partition the total (first-writer-wins)', () => {
    const res = build(['2026-12-25', '2026-12-26', '2027-01-01'], '2026-12-01', '2027-01-31');
    assert.equal(res.count, res.short + res.vacation + res.connecting + res.weekend);
  });
  it('every departure sits inside the horizon', () => {
    const res = build(['2026-12-25'], '2026-12-01', '2027-01-31');
    for (const key of res.keySet) {
      const dep = key.split('|')[0];
      assert.ok(dep >= '2026-12-01' && dep <= '2027-01-31', `departure ${dep} out of horizon`);
    }
  });
});
