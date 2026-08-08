// scripts/select-combo.test.mjs — behavioural tests for the duration-target selection.
//
// Exercises selectCombo() and targetSet() directly. Both are pure and exported from
// fetch-prices.mjs; importing that module runs NONE of the collector's boot side effects
// (no env exit, no Supabase client, no live run) because they gate on IS_ENTRYPOINT, so these
// tests need no TP_TOKEN / SUPABASE_SERVICE_KEY and make no network calls.
//
// SCOPE: the (b) duration-target part only. The exact-vs-±1 rule is:
//   • an offer of EXACTLY t nights wins the target (cheapest such), target_exact=true, actual=null;
//   • otherwise the cheapest offer within ±1 night, target_exact=false, actual=its real nights;
//   • neither → the target is skipped and nothing is written for it.
// The cheap pool (a) and break windows (c) are covered only by a light regression check at the end.
//
// RUNNER: node:test (`npm test` → `node --test`), same as the other tests in this repo.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { selectCombo, targetSet } from './fetch-prices.mjs';

// A minimal offer. selectCombo keys on departure_at|return_at, so each call below hands out
// distinct dates; price drives the "cheapest" tie-break, nights drives target matching.
let seq = 0;
const mk = (nights, price) => {
  seq += 1;
  const dep = `2026-09-${String((seq % 27) + 1).padStart(2, '0')}`;
  return { departure_at: dep, return_at: `${dep}#${seq}`, nights, price };
};

// Unknown IATAs miss the coord maps, so targetSet falls back to its default [5,7,10,12,14] — the
// set these selectCombo cases assume. targetSet's own values are asserted separately below.
const run = (offers, breakKeys) => selectCombo(offers, '__', '__', breakKeys);
const forTarget = (res, t) => res.find((o) => o.target_nights === t);

describe('selectCombo (b) — targetSet default carries 12 nights in every group', () => {
  it('the fallback set is exactly [5,7,10,12,14]', () => {
    assert.deepEqual(targetSet('__', '__'), [5, 7, 10, 12, 14]);
  });
});

describe('selectCombo (b) — exact target length', () => {
  it('an exact-length offer wins its target even when a cheaper ±1 offer exists', () => {
    // 6 nights is cheaper AND within ±1 of 7, but the exact 7-night must take target 7.
    const seven = mk(7, 100);
    const six = mk(6, 50);
    const res = run([seven, six]);
    const t7 = forTarget(res, 7);
    assert.ok(t7, 'target 7 should be filled');
    assert.equal(t7.nights, 7);
    assert.equal(t7.target_exact, true);
    assert.equal(t7.target_actual_nights, null);
    // The cheaper 6-night did NOT capture target 7 (it lands on target 5 instead, inexact).
    assert.notEqual(res.find((o) => o.return_at === six.return_at).target_nights, 7);
  });

  it('12 nights is a real target now — an exact 12-night offer is tagged exact', () => {
    const res = run([mk(12, 100)]);
    const t12 = forTarget(res, 12);
    assert.ok(t12, 'target 12 should be filled');
    assert.equal(t12.target_exact, true);
    assert.equal(t12.target_actual_nights, null);
  });
});

describe('selectCombo (b) — ±1 replacement carries the real length', () => {
  it('with no exact match, the ±1 offer is tagged inexact with its actual nights', () => {
    // 8 nights matches target 7 (±1) but NOT target 5 (±1 = 4/5/6), so it is unambiguously target 7.
    const res = run([mk(8, 100)]);
    const t7 = forTarget(res, 7);
    assert.ok(t7, 'target 7 should be filled by the ±1 fallback');
    assert.equal(t7.nights, 8);
    assert.equal(t7.target_exact, false);
    assert.equal(t7.target_actual_nights, 8);
  });
});

describe('selectCombo (b) — a target with no offer in range is skipped', () => {
  it('nothing within ±1 of any target → no target_nights written at all', () => {
    // 3 and 20 nights sit outside ±1 of every target in [5,7,10,12,14].
    const res = run([mk(3, 100), mk(20, 120)]);
    assert.ok(res.length > 0, 'offers still survive via the cheap pool');
    assert.ok(res.every((o) => o.target_nights === null), 'no target should be filled');
    assert.ok(res.every((o) => o.target_exact === false && o.target_actual_nights === null));
  });
});

describe('selectCombo (b) — first target wins on a shared offer', () => {
  it('an 11-night offer serves target 10 before target 12; the first tag stays', () => {
    // 11 is within ±1 of both 10 and 12; targets run ascending, so 10 claims it first.
    const res = run([mk(11, 100)]);
    const tagged = res.find((o) => o.target_nights != null);
    assert.ok(tagged, 'the offer should carry a target tag');
    assert.equal(tagged.target_nights, 10);
    assert.equal(tagged.target_exact, false);
    assert.equal(tagged.target_actual_nights, 11);
    assert.equal(forTarget(res, 12), undefined, 'target 12 must not also be written');
  });
});

describe('selectCombo (a)/(c) — untouched behaviour still holds', () => {
  it('the cheap pool still tags offers, and a break window still tags + dedups onto a target', () => {
    const exactSeven = mk(7, 90); // exact target 7 AND cheap
    const key = `${exactSeven.departure_at}|${exactSeven.nights}`;
    const res = run([exactSeven], new Set([key]));
    const o = res.find((x) => x.return_at === exactSeven.return_at);
    assert.equal(res.length, 1, 'one offer, one row — no duplication across cheap/target/break');
    assert.equal(o.in_cheap_pool, true);
    assert.equal(o.target_nights, 7);
    assert.equal(o.target_exact, true);
    assert.equal(o.in_break_window, true);
  });
});
