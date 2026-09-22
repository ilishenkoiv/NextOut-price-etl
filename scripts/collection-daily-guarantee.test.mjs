// Daily-main guarantee — simulation-backed proofs. Drives the REAL SequentialSchedule via
// scripts/collection-daily-sim.mjs (SLOTS, 24h main cycle, mainAtRisk and tail-yield all exercised
// for real). Conservative model anchored to the 2026-09-20 production audit: 235-min sessions,
// single provider request in flight, ~24 realized main cells/min, one transient DB failure that
// kills a session (the observed 00:0x UTC "Collection database operation failed").
//
// Each test asserts what the numbers ACTUALLY show — no assertion is loosened to force green.
// Where a lever is insufficient, the test proves the insufficiency; the guarantee is asserted only
// against the configuration that genuinely reaches ≤24h with ≥20% reserve.
import test from 'node:test';
import assert from 'node:assert/strict';
import { simulate, reserveOf, hrs, DAY } from './collection-daily-sim.mjs';
import { MAIN_CYCLE_MS } from './collection-schedule.mjs';

const WAVE10 = 13_440;     // observed main.total at wave 10 (audit heartbeats)
const WAVE43 = 17_800;     // wave 43: 13,440 + ~726 new unseen routes ×6 months (all routes to the
                           // 33 new destinations start unseen → mainPlan puts them in `live`)
const RATE = 24;           // realized main cells/min (back-derived from wave-10 ≈ 1.5–2 days)
const DBFAIL = { day: 0, session: 2 };

test('CALIBRATION: the model reproduces the observed ~1.5–2 day wave-10 pass (current scheme)', async () => {
  const r = await simulate({ guaranteeDailyMain: false, sessions: 3, mainTotal: WAVE10, mainRate: RATE, dbFailAt: DBFAIL });
  assert.ok(r.elapsedMs != null, 'wave-10 eventually completes');
  const days = r.elapsedMs / DAY;
  assert.ok(days >= 1.3 && days <= 2.2, `wave-10 current pass = ${hrs(r.elapsedMs)}h (~${days.toFixed(2)}d), expected ~1.5–2d`);
});

test('PROBLEM: the current scheme cannot finish a wave-43 pass within 24h', async () => {
  const r = await simulate({ guaranteeDailyMain: false, sessions: 3, mainTotal: WAVE43, mainRate: RATE, dbFailAt: DBFAIL });
  assert.ok(r.elapsedMs > MAIN_CYCLE_MS, `current wave-43 must exceed 24h, got ${hrs(r.elapsedMs)}h`);
});

test('PROOF: tail→main reallocation ALONE is not enough at 3 sessions/day (runtime-ceiling bound)', async () => {
  // 3 completing sessions × 235 min × ~24 cells/min is below wave-43 (17,800) no matter how the time
  // is split, so even yielding every tail slot to main cannot beat the ceiling. Asserted, not fudged.
  const r = await simulate({ guaranteeDailyMain: true, sessions: 3, mainTotal: WAVE43, mainRate: RATE, dbFailAt: DBFAIL });
  assert.ok(r.elapsedMs > MAIN_CYCLE_MS, `tail-yield @3 sessions still >24h, got ${hrs(r.elapsedMs)}h`);
});

test('PROOF: doubling throughput at 3 sessions still misses 24h — sessions/day is the real lever', async () => {
  const r = await simulate({ guaranteeDailyMain: true, sessions: 3, mainTotal: WAVE43, mainRate: RATE * 2, dbFailAt: DBFAIL });
  assert.ok(r.elapsedMs > MAIN_CYCLE_MS, `tail-yield + 2× rate @3 sessions still >24h, got ${hrs(r.elapsedMs)}h`);
});

test('SOLUTION (recommended): tail-yield + the existing 6 healthy cron slots finishes wave-43 ≤24h with ≥20% reserve', async () => {
  // The cron ALREADY fires 6×/day (`7 */4`). No schedule change — this is the state once the
  // transient midnight-DB failure no longer kills a session (all 6 complete).
  const r = await simulate({ guaranteeDailyMain: true, sessions: 6, mainTotal: WAVE43, mainRate: RATE, dbFailAt: null });
  assert.ok(r.elapsedMs <= MAIN_CYCLE_MS, `wave-43 must finish ≤24h, got ${hrs(r.elapsedMs)}h`);
  assert.ok(reserveOf(r.elapsedMs) >= 0.20, `need ≥20% reserve, got ${(reserveOf(r.elapsedMs) * 100).toFixed(0)}% (${hrs(r.elapsedMs)}h)`);
});

test('MARGIN: with 6 slots but one session still lost, ≤24h holds but reserve thins below 20% at 24 cells/min', async () => {
  // Honest sensitivity: losing one of the six sessions clears 24h yet only ~16% reserve remains,
  // so the reliability fix (or a small throughput bump) is what secures the 20% margin.
  const r = await simulate({ guaranteeDailyMain: true, sessions: 6, mainTotal: WAVE43, mainRate: RATE, dbFailAt: DBFAIL });
  assert.ok(r.elapsedMs <= MAIN_CYCLE_MS, `still ≤24h with a lost session, got ${hrs(r.elapsedMs)}h`);
  assert.ok(reserveOf(r.elapsedMs) < 0.20, `documents thin margin, got ${(reserveOf(r.elapsedMs) * 100).toFixed(0)}%`);
});

test('SOLUTION (robust): tail-yield + 6 slots + one lost session + ~1.2× throughput restores ≥20% reserve', async () => {
  const r = await simulate({ guaranteeDailyMain: true, sessions: 6, mainTotal: WAVE43, mainRate: 28, dbFailAt: DBFAIL });
  assert.ok(r.elapsedMs <= MAIN_CYCLE_MS && reserveOf(r.elapsedMs) >= 0.20,
    `expected ≤24h with ≥20% reserve, got ${hrs(r.elapsedMs)}h / ${(reserveOf(r.elapsedMs) * 100).toFixed(0)}%`);
});
