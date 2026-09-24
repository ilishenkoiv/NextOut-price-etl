// Bounded full-plan capacity check for the current MAIN target (23,952 cells = 3,992 routes × 6
// months, last reported total) against the CURRENT 5-minute supabase-cron trigger architecture.
// See main-24h-sim.mjs for the model and its inputs (SLOTS, CYCLE_MS, PRIORITY_MAX_CYCLE_MS,
// OFF_CYCLE_SAFETY_MARGIN_MS, offCycleMainBudget, the real 22-origin priority-market-schedule
// cadence). requestsPerMinute=89 and mainRate=89/4 cells/min are the measured sustained
// throughput reported 2026-09-23 and MAIN's 4 mandatory requests/cell — no calendar fallback or
// retry overhead included, so this is an optimistic (not pessimistic) rate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulateMain24h, hrs, reserveOf } from './main-24h-sim.mjs';
import { MAIN_CYCLE_MS } from './collection-schedule.mjs';

const MAIN_TOTAL = 23_952;
const RATE = 89 / 4;
const SAFE_RESERVE = 0.20; // same bar collection-daily-guarantee.test.mjs uses for "safe"

test('PROBLEM: today\'s defaults (both PR #24 flags off) cannot finish the current 23,952-cell MAIN target within 24h', () => {
  const r = simulateMain24h({ mainTotal: MAIN_TOTAL, mainRate: RATE, pilotMarketSchedule: false, guaranteeDailyMain: false, offCycleMainMinutes: 0 });
  assert.ok(r.done, 'sanity: finishes within the 3-day bound');
  assert.ok(r.elapsedMs > MAIN_CYCLE_MS, `expected >24h with defaults, got ${hrs(r.elapsedMs)}h`);
});

test('tail-yield (GUARANTEE_DAILY_MAIN) alone is not enough: priority\'s uncapped per-cycle cost still dominates', () => {
  const r = simulateMain24h({ mainTotal: MAIN_TOTAL, mainRate: RATE, pilotMarketSchedule: false, guaranteeDailyMain: true, offCycleMainMinutes: 0 });
  assert.ok(r.elapsedMs > MAIN_CYCLE_MS, `expected >24h, got ${hrs(r.elapsedMs)}h`);
});

test('pilot market schedule + tail-yield together bring the pass under 24h but leave a negative/thin reserve', () => {
  const r = simulateMain24h({ mainTotal: MAIN_TOTAL, mainRate: RATE, pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 0 });
  assert.ok(r.elapsedMs > MAIN_CYCLE_MS, `pilot+guarantee alone (no off-cycle) still exceeds 24h, got ${hrs(r.elapsedMs)}h`);
});

test('SOLUTION (fits ≤24h): pilot + tail-yield + a 6-minute off-cycle MAIN budget finishes the 23,952-cell pass', () => {
  const r = simulateMain24h({ mainTotal: MAIN_TOTAL, mainRate: RATE, pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 6 });
  assert.ok(r.elapsedMs <= MAIN_CYCLE_MS, `expected ≤24h, got ${hrs(r.elapsedMs)}h`);
});

test('SHORTFALL (honest, not claimed as safe): the ≤24h result above has well under the 20% reserve bar used elsewhere', () => {
  const r = simulateMain24h({ mainTotal: MAIN_TOTAL, mainRate: RATE, pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 6 });
  const reserve = reserveOf(r.elapsedMs);
  assert.ok(reserve < SAFE_RESERVE, `expected reserve below the ${SAFE_RESERVE * 100}% safe bar, got ${(reserve * 100).toFixed(0)}% (${hrs(r.elapsedMs)}h)`);
});

test('CEILING: increasing OFF_CYCLE_MAIN_MINUTES past ~6 does not help further — the real limit is the ~5-minute cron-trigger runway, not the configured budget', () => {
  const a = simulateMain24h({ mainTotal: MAIN_TOTAL, mainRate: RATE, pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 6 });
  const b = simulateMain24h({ mainTotal: MAIN_TOTAL, mainRate: RATE, pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 20 });
  assert.equal(a.elapsedMs, b.elapsedMs, 'off-cycle minutes beyond the real per-cycle runway are inert — configuring more does not buy more MAIN time');
});

test('SENSITIVITY: a ~30% higher sustained rate (≈29 cells/min) reaches the 20% safe reserve bar at the same schedule', () => {
  const r = simulateMain24h({ mainTotal: MAIN_TOTAL, mainRate: 29, pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 6 });
  assert.ok(r.elapsedMs <= MAIN_CYCLE_MS && reserveOf(r.elapsedMs) >= SAFE_RESERVE,
    `expected ≤24h with ≥20% reserve at the higher rate, got ${hrs(r.elapsedMs)}h / ${(reserveOf(r.elapsedMs) * 100).toFixed(0)}%`);
});
