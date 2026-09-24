// Bounded full-plan capacity check for the current MAIN target (23,952 cells = 3,992 routes × 6
// months, last reported total) against the CURRENT 5-minute supabase-cron trigger architecture.
// See main-24h-sim.mjs for the model, its calibration history, and its inputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateMain24h, cellsPerTick, cellsPerTickRange, hrs, reserveOf, DUE_SESSION_MAIN_TICKS_OBSERVED } from './main-24h-sim.mjs';
import { MAIN_CYCLE_MS } from './collection-schedule.mjs';
import { projectMainCellMs } from './collection-adapters.mjs';

const MAIN_TOTAL = 23_952;
const CLEAN_MS_PER_CELL = projectMainCellMs({ requestMs: 180, dbMs: 100 }); // matches main-24h-sim.mjs's calibration comment
const SAFE_RESERVE = 0.20; // same bar collection-daily-guarantee.test.mjs uses for "safe"

test('CALIBRATION: flags-off replay of the exact observed production cycle (35885635003, 2026-09-23T16:00Z, wave 43, GUARANTEE_DAILY_MAIN=true) predicts a MAIN delta close to the real 89-cell checkpoint advance, not the previous model\'s 318', () => {
  const startInstant = Date.parse('2026-09-23T16:00:00.000Z');
  const r = simulateMain24h({
    mainTotal: 17730, sessionBudgetMinutes: 25, pilotMarketSchedule: false, guaranteeDailyMain: true,
    offCycleMainMinutes: 0, startInstant, maxDays: 1, msPerCellForTick: CLEAN_MS_PER_CELL,
  });
  const predicted = r.log[0].cellsThisCycle;
  const ACTUAL_OBSERVED_DELTA = 89; // docs/terminal-status/2026-09-23-01-etl-final.md:179
  assert.ok(Math.abs(predicted - ACTUAL_OBSERVED_DELTA) <= 5,
    `expected the replay to land within one tick's rounding of the observed 89-cell delta, got ${predicted}`);
  assert.equal(r.log[0].dueSessionMainTicks, DUE_SESSION_MAIN_TICKS_OBSERVED, 'the due session gets exactly the evidenced tick ceiling, not the old continuous-rate estimate');
});

test('cellsPerTick is bounded-unit floor division (MAIN_UNIT_WORK_MS / msPerCell), never a continuous rate', () => {
  assert.equal(cellsPerTick(1000), 75);   // 75_000 / 1000
  assert.equal(cellsPerTick(74999), 1);
  assert.equal(cellsPerTick(75001), 0 + 1); // floors to zero cells but never below 1 (a tick that starts always yields >=1 cell)
  assert.throws(() => cellsPerTick(0), /Invalid msPerCell/);
});

test('cellsPerTickRange blends a labeled calendar-fallback/retry assumption onto the real MAIN_REQUIRED_PROVIDER_CALLS cost model, low <= high', () => {
  const { low, high } = cellsPerTickRange();
  assert.ok(low > 0 && high > 0 && low <= high, `expected a sane low<=high range, got ${low}/${high}`);
});

test('PROBLEM: today\'s defaults (both PR #24 flags off) do not finish the current 23,952-cell MAIN target within 3 days at the corrected bounded-tick rate', () => {
  const r = simulateMain24h({ mainTotal: MAIN_TOTAL, pilotMarketSchedule: false, guaranteeDailyMain: false, offCycleMainMinutes: 0, msPerCellForTick: CLEAN_MS_PER_CELL });
  assert.equal(r.done, false, 'flags-off, at the evidenced 1-tick-per-due-session ceiling, does not even reach the target in 3 days — consistent with the ~8.3-day production-log estimate, not the old model\'s ~38h');
});

test('SOLUTION CANDIDATE: pilot + tail-yield + a real 20-minute off-cycle runway reaches <=24h across the whole defensible blended rate range, with the low end still meeting the 20% safe-reserve bar', () => {
  const { low, high } = cellsPerTickRange();
  const lowRate = simulateMain24h({ mainTotal: MAIN_TOTAL, pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 20, msPerCellForTick: 75_000 / low });
  const highRate = simulateMain24h({ mainTotal: MAIN_TOTAL, pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 20, msPerCellForTick: 75_000 / high });
  assert.ok(highRate.done && hrs(highRate.elapsedMs) <= 24, `expected the high end of the rate range to fit <=24h, got ${hrs(highRate.elapsedMs)}h`);
  assert.ok(lowRate.done && hrs(lowRate.elapsedMs) <= 24 && reserveOf(lowRate.elapsedMs) >= SAFE_RESERVE,
    `expected even the low end of the defensible BLENDED range to fit <=24h with a safe reserve, got ${hrs(lowRate.elapsedMs)}h / ${(reserveOf(lowRate.elapsedMs)*100).toFixed(0)}%`);
  // This does NOT cover the fully-degraded worst case (every cell needs both calendar fallback and
  // a retry) — see the CLI's own 'low rate'/'high rate' scenarios in main-24h-sim.mjs, which use
  // that worst case explicitly and land at ~21.5h/10% reserve, below the safe bar. Both numbers
  // belong in the report; neither alone is "the" answer.
});

test('distinct processed/found/no-result/error counters never double-count or exceed processed', () => {
  const r = simulateMain24h({ mainTotal: 5000, pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 20, msPerCellForTick: CLEAN_MS_PER_CELL });
  const { processed, found, noResult, errors } = r.counts;
  assert.equal(found + noResult + errors, processed, 'found+noResult+errors must reconcile exactly to processed, with no silent drop or double count');
  assert.ok(processed <= 5000);
});

test('CEILING: increasing OFF_CYCLE_MAIN_MINUTES past what the real runway allows is inert — the ceiling is the cron-trigger runway and LOWER_PHASE_RESERVE_MS, not the configured minutes', () => {
  const a = simulateMain24h({ mainTotal: MAIN_TOTAL, pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 20, msPerCellForTick: CLEAN_MS_PER_CELL });
  const b = simulateMain24h({ mainTotal: MAIN_TOTAL, pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 60, msPerCellForTick: CLEAN_MS_PER_CELL });
  assert.equal(a.elapsedMs, b.elapsedMs, 'off-cycle minutes beyond the real per-cycle runway are inert — configuring more does not buy more MAIN time');
});
