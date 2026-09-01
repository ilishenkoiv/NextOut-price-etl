import assert from 'node:assert/strict';
import test from 'node:test';
import { planWindowDestinations } from './window-destination-plan.mjs';

const allDests = Array.from({ length: 138 }, (_, index) => `D${String(index).padStart(3, '0')}`);
const findCount = new Map(allDests.slice(0, 60).map((dest, index) => [dest, 1000 - index]));

test('auto mode always includes the historical top 50 and one seventh of the remaining catalogue', () => {
  const plan = planWindowDestinations({ allDests, findCount, planDate: '2026-09-01' });
  assert.deepEqual(plan.top, allDests.slice(0, 50));
  assert.ok(plan.top.every((dest) => plan.selected.includes(dest)));
  assert.equal(plan.wholeTailCount, 88);
  assert.ok(plan.tail.length === 12 || plan.tail.length === 13);
  assert.equal(plan.selected.length, 50 + plan.tail.length);
});

test('seven consecutive dates cover every tail destination exactly once, including across a year boundary', () => {
  const dates = ['2026-12-29', '2026-12-30', '2026-12-31', '2027-01-01', '2027-01-02', '2027-01-03', '2027-01-04'];
  const tails = dates.map((planDate) => planWindowDestinations({ allDests, findCount, planDate }).tail);
  const flattened = tails.flat();
  assert.equal(flattened.length, 88);
  assert.equal(new Set(flattened).size, 88);
  assert.deepEqual([...new Set(tails.map((_, index) => planWindowDestinations({ allDests, findCount, planDate: dates[index] }).slice))].sort(), [0, 1, 2, 3, 4, 5, 6]);
});

test('manual modes retain a forced full catalogue and a top-only diagnostic run', () => {
  assert.equal(planWindowDestinations({ allDests, findCount, planDate: '2026-09-01', mode: 'full' }).selected.length, 138);
  assert.deepEqual(
    planWindowDestinations({ allDests, findCount, planDate: '2026-09-01', mode: 'top-only' }).selected,
    allDests.slice(0, 50),
  );
});

test('sparse fare history is deterministically filled to a real top 50', () => {
  const sparseHistory = new Map(allDests.slice(0, 12).map((dest, index) => [dest, 100 - index]));
  const plan = planWindowDestinations({ allDests, findCount: sparseHistory, planDate: '2026-09-01' });
  assert.equal(plan.top.length, 50);
  assert.deepEqual(plan.top.slice(0, 12), allDests.slice(0, 12));
  assert.equal(plan.wholeTailCount, 88);
});

test('an empty history bootstraps with the full catalogue', () => {
  const plan = planWindowDestinations({ allDests, findCount: new Map(), planDate: '2026-09-01' });
  assert.equal(plan.bootstrap, true);
  assert.deepEqual(plan.selected, allDests);
});

test('invalid plan dates fail instead of silently choosing the wrong weekly slice', () => {
  assert.throws(
    () => planWindowDestinations({ allDests, findCount, planDate: '2026-02-30' }),
    /real calendar date/,
  );
});
