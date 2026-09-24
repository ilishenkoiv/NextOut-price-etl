// Cycle-by-cycle capacity model for a full MAIN sweep under the CURRENT 5-minute
// supabase-cron trigger architecture (single serialized runner, one due session of
// COLLECTION_SESSION_MINUTES per 30-min priority cycle, optional off-cycle MAIN top-up in the
// remaining minutes before the next due cycle).
//
// CALIBRATION HISTORY (do not regress this): the first version of this model (see git history)
// treated MAIN's nominal per-cycle slot (SLOTS `main`, 23 minutes minus any capped priority
// overrun) as a continuously-consumable rate — cellsThisCycle = minutesAvailable * cellsPerMinute.
// Replayed against real production run 35885635003 (2026-09-23T16:00Z, wave 43,
// GUARANTEE_DAILY_MAIN=true, both PR #24 flags off), that model predicted 318 MAIN cells for the
// cycle; the actual checkpointed delta was 89 (main-24h-sim.test.mjs asserts this replay). The
// model was wrong for two compounding, code-grounded reasons, neither previously represented here:
//
// 1. MAIN is a BOUNDED ADAPTER UNIT, not a continuous slot. `collection-adapters.mjs`'s main
//    adapter does at most MAIN_UNIT_WORK_MS of provider/DB work per call before returning its
//    checkpoint (admitted only if MAIN_UNIT_ADMIT_MS still fits the caller's deadline) —
//    SequentialSchedule.tick() performs exactly one such bounded unit and returns. Minutes convert
//    to cells only in whole-tick increments, not continuously.
// 2. A regular (non-off-cycle) due session that reaches MAIN after a priority overrun was observed
//    to get exactly ONE productive tick before the whole session went idle and exited (automated
//    idle-exit, run-collection.mjs). The evidenced mechanism: the main adapter's step() can throw
//    CollectionYield when a provider call would cross its unit deadline, which the adapter reports
//    as `status:'yield'` (collection-adapters.mjs) rather than `'progress'`; unlike `'progress'`,
//    `'yield'` both advances SequentialSchedule's phase (main -> tail) AND sets a 60s `retryAt`
//    cooldown on the main job. If tail/fast/maintenance are simultaneously empty or in their own
//    cooldowns (FAST returned `empty` in both sampled sessions: cursor stuck at 21/400), the
//    reserve phase's task loop exits via the FIRST empty/yield status it hits without trying the
//    remaining candidates (collection-schedule.mjs's `for` loop `break`s, it does not `continue`),
//    cascading the whole tick() to `status:'idle'` well before MAIN's nominal 23-minute budget (or
//    even the 25-minute session budget) is exhausted.
//
// SECOND OBSERVATION (2026-09-24T18:30Z, cycle 994597, run 36041653012, GUARANTEE_DAILY_MAIN=true,
// wave 43, OFF_CYCLE_MAIN_MINUTES/PRIORITY_MARKET_SCHEDULE both unset — same flags-off production
// as run 35885635003 above): priority overran almost the entire 25-minute due session
// (priorityLagMs reported 568,628-1,306,860ms of backlog across the session; priority did not
// report status:'done' until 18:39:28, ~9 minutes before session end) and MAIN's checkpoint only
// moved once, from cursor 1906 to 1985 (+79 cells) in the ~68s between priority's done event and
// the next tail progress report. +79 in one tick is the same order of magnitude as the first
// data point's +89, not the old continuous-rate model's 318 — a second independent confirmation
// of the bounded-single-tick failure mode this file models, under a *worse* real overrun than the
// first sample. It also independently corroborates the plan doc's flags-off multi-day estimate:
// production's MAIN cursor was 1985/23,952 (8.3%) at this timestamp. This is a documented
// observation, not a strict-tolerance replay test (unlike the first point) — the exact
// priority-overrun timing that produced it is not fully recoverable from step-level logs alone
// (see MEASUREMENT GAP below), so it is not asserted to a fixed delta in main-24h-sim.test.mjs.
//
// (1) is now modeled exactly (imported real constants). (2) is the harder, timing-sensitive part:
// whether a real due session gets 1 tick or several depends on exactly when, mid-unit, a provider
// call happens to cross the deadline — not observable from GH Actions step-level logs alone (see
// the MEASUREMENT GAP note on DUE_SESSION_MAIN_TICKS below). Off-cycle sessions do not share this
// failure mode in the same way: `runBoundedMainAdvance` (collection-schedule.mjs) keeps calling
// tick() itself until true idle or its own runway is exhausted, so multiple bounded main ticks
// DO land there (see collection-schedule.test.mjs) — this file models that path exactly, using the
// same admission math, rather than approximating it.
import { SLOTS, CYCLE_MS, PRIORITY_MAX_CYCLE_MS, MAIN_CYCLE_MS, LOWER_PHASE_RESERVE_MS, offCycleMainBudget } from './collection-schedule.mjs';
import { originDueThisCycle } from './priority-market-schedule.mjs';
import { ORIGINS_ALL } from '../src/data/origins.js';
import { MAIN_REQUIRED_PROVIDER_CALLS, MAIN_UNIT_WORK_MS, MAIN_UNIT_ADMIT_MS, projectMainCellMs } from './collection-adapters.mjs';

const MIN = 60_000;
// Mirrors run-collection.mjs OFF_CYCLE_SAFETY_MARGIN_MS exactly (not re-imported to avoid pulling
// in @supabase/supabase-js for a pure capacity model); collection-workflows.test.mjs asserts the
// two stay in lockstep.
export const OFF_CYCLE_SAFETY_MARGIN_MS = 90_000;

// MEASUREMENT GAP: this is the single most consequential unmeasured input in the whole model. We
// have exactly one directly observed data point (production run 35885635003: 1 productive main
// tick, then idle-exit) and no way, from step-level GH Actions logs alone, to tell whether that is
// typical or a worst case — it depends on per-request latency variance relative to the unit
// deadline and on whether fast/tail/maintenance happen to be simultaneously in a retry cooldown.
// Minimum measurement needed to replace this constant with a real distribution: temporarily log
// `working.frame.phase`/task/status on every SequentialSchedule.tick() call (not throttled to one
// report/minute like run-collection.mjs's current reporting) across at least one full 24h window,
// across both priority-light and priority-heavy cycles.
export const DUE_SESSION_MAIN_TICKS_OBSERVED = 1;

const nominalSlotMinutes = task => {
  const slot = SLOTS.find(s => s.task === task);
  return slot.to - slot.from;
};

// Full (all-origins-due) priority workload per cycle, per docs/ETL-INTEGRATION-2026-09-22.md and
// collection-schedule.mjs (220 roulette tickets + 459 saved-window groups + up to 10 audit claims
// + observed replacement overhead), scaled linearly by the fraction of the 22-origin catalogue
// that is actually due this cycle under the pilot cadence. Non-pilot: always the full cost.
export function priorityMinutesThisCycle(instant, { pilotMarketSchedule, requestsPerMinute, fullCycleRequests = 954 }) {
  if (!pilotMarketSchedule) return fullCycleRequests / requestsPerMinute;
  const dueCount = ORIGINS_ALL.filter(origin => originDueThisCycle(instant, origin)).length;
  // Audit claims are origin-independent (feedback-driven); keep a fixed floor so a fully
  // mainOnly (night) cycle still spends the ~10-claim audit budget, matching priority.step.
  const auditRequests = 10;
  const perOriginRequests = (fullCycleRequests - auditRequests) / ORIGINS_ALL.length;
  return (auditRequests + dueCount * perOriginRequests) / requestsPerMinute;
}

// Cells a single bounded MAIN tick realizes: floor(work-time-per-tick / time-per-cell), at least 1.
// `msPerCell` should come from `projectMainCellMs` (real MAIN_REQUIRED_PROVIDER_CALLS-based cost),
// not a bare req/min figure — see cellsPerTickRange below for the defensible low/high inputs.
export function cellsPerTick(msPerCell) {
  if (!(msPerCell > 0)) throw new Error('Invalid msPerCell');
  return Math.max(1, Math.floor(MAIN_UNIT_WORK_MS / msPerCell));
}

// Defensible sustained-rate range for cellsPerTick, built from the real MAIN_REQUIRED_PROVIDER_CALLS
// cost model (projectMainCellMs), not the single undurated "89 req/min" burst that caused the
// original 5-10x miscalibration (see docs/terminal-status/2026-09-24-01-main24h.md). `requestMs`
// bounds come from the observed floor (89 cells in <=75s of real work implies requestMs no higher
// than ~190ms at zero fallback/retry — collection-adapters.mjs:103-105, run 35885635003) and a
// conservative slower assumption for the high end. `calendarFallbackRate`/`retryRate` are explicit,
// separately-labeled ASSUMPTIONS (not measured from these logs): calendar fallback only triggers
// when BOTH required probes come back positively empty, and retryRate approximates transient
// provider failures at the real observed MAIN error rate (10 errors / 15,882 processed = ~0.06%,
// docs/terminal-status/2026-09-23-01-etl-final.md / 2026-09-23-etl-overnight-baseline.md).
export function cellsPerTickRange({
  requestMsLow = 160, requestMsHigh = 260, dbMs = 100,
  calendarFallbackRate = 0.15, // ASSUMPTION: not measured here; needs a real price-table read to confirm
  retryRate = 0.0006,          // measured: production MAIN error rate, see comment above
} = {}) {
  const blend = requestMs => {
    const clean = projectMainCellMs({ requestMs, dbMs });
    const degraded = projectMainCellMs({ requestMs, dbMs, calendarFallback: true, retryCalls: 1 });
    return clean * (1 - calendarFallbackRate - retryRate) + degraded * (calendarFallbackRate + retryRate);
  };
  return { low: cellsPerTick(blend(requestMsHigh)), high: cellsPerTick(blend(requestMsLow)) };
}

// One 30-minute cycle. Priority (and any of its overrun) is unchanged from before — those are real,
// imported constants and already correctly modeled. What changed: MAIN's own yield is now whole
// bounded ticks (due-session ticks capped at the evidenced DUE_SESSION_MAIN_TICKS_OBSERVED ceiling;
// off-cycle ticks computed from the real runway via offCycleMainBudget, uncapped by that ceiling
// since runBoundedMainAdvance's own loop — not a single due session's yield/cooldown cascade —
// governs it there).
function cycleMainCells(cycleStart, { pilotMarketSchedule, guaranteeDailyMain, offCycleMainMinutes,
  requestsPerMinute, sessionBudgetMinutes, mainAtRisk, msPerCellForTick, dueSessionTickCeiling }) {
  const priorityMin = priorityMinutesThisCycle(cycleStart, { pilotMarketSchedule, requestsPerMinute });
  const priorityOverrun = Math.max(0, priorityMin - nominalSlotMinutes('priority'));
  const cappedPriorityOverrun = Math.min(priorityOverrun, PRIORITY_MAX_CYCLE_MS / MIN - nominalSlotMinutes('priority'));
  const fastMin = nominalSlotMinutes('fast');
  const tailMin = guaranteeDailyMain && mainAtRisk ? 0 : nominalSlotMinutes('tail'); // tail yields to main
  const maintMin = nominalSlotMinutes('maintenance');
  const dueSessionMainMinAvailable = Math.max(0, nominalSlotMinutes('main') - cappedPriorityOverrun);
  const ticksThatFit = Math.floor((dueSessionMainMinAvailable * MIN) / MAIN_UNIT_ADMIT_MS);
  const dueSessionMainTicks = Math.min(ticksThatFit, dueSessionTickCeiling);
  const dueSessionMainMinUsed = Math.min(dueSessionMainMinAvailable, dueSessionMainTicks * MAIN_UNIT_ADMIT_MS / MIN);
  // Everything the due session itself does not use is only reachable through a SEPARATE off-cycle
  // trigger, which must still respect the real safety margin before the next due cycle.
  const dueSessionUsedMin = Math.min(sessionBudgetMinutes, nominalSlotMinutes('priority') + priorityMin - priorityOverrun + fastMin + dueSessionMainMinUsed + tailMin + maintMin);
  const cycleEnd = cycleStart + CYCLE_MS;
  const offCycleStart = cycleStart + dueSessionUsedMin * MIN;
  let offCycleTicks = 0;
  if (offCycleMainMinutes > 0 && offCycleStart < cycleEnd) {
    const stopAt = offCycleMainBudget(offCycleStart, { safetyMarginMs: OFF_CYCLE_SAFETY_MARGIN_MS, maxSessionMs: offCycleMainMinutes * MIN });
    if (stopAt) offCycleTicks = Math.max(0, Math.floor((stopAt - offCycleStart - LOWER_PHASE_RESERVE_MS) / MAIN_UNIT_ADMIT_MS));
  }
  const totalTicks = dueSessionMainTicks + offCycleTicks;
  return { mainCells: totalTicks * cellsPerTick(msPerCellForTick), priorityMin, dueSessionMainTicks, offCycleTicks };
}

// Runs a full simulated day (48 cycles) tracking a single MAIN pass's cursor, plus distinct
// processed/found/no-result/error counters (found/no-result split is a labeled ASSUMPTION — see
// `foundRate` below; processed and errors follow directly from cellsThisCycle and the measured
// production error rate).
export function simulateMain24h({ mainTotal, requestsPerMinute = 89, sessionBudgetMinutes = 25,
  pilotMarketSchedule = false, guaranteeDailyMain = false, offCycleMainMinutes = 0, startInstant = 0, maxDays = 3,
  msPerCellForTick = projectMainCellMs({ requestMs: 200, dbMs: 100 }),
  dueSessionTickCeiling = DUE_SESSION_MAIN_TICKS_OBSERVED,
  errorRate = 0.0006,
  // ASSUMPTION, not measured from these production logs: proxy taken from the overnight baseline's
  // shared-window freshness split (fresh=736/unavailable=137 -> 84.3%), docs/terminal-status/
  // 2026-09-23-etl-overnight-baseline.md. MAIN's own found/no-result split needs a real read of the
  // `prices` table to confirm; flagged here rather than silently assumed as fact.
  foundRate = 0.843,
} = {}) {
  let cursor = 0; let now = startInstant; const passStart = startInstant;
  const cycleMs = CYCLE_MS;
  let cycleStart = Math.floor(now / cycleMs) * cycleMs;
  const cycles = [];
  let processed = 0, found = 0, noResult = 0, errors = 0;
  while (cursor < mainTotal && now - passStart < maxDays * 24 * 60 * MIN) {
    const remaining = mainTotal - cursor;
    const remainingWall = MAIN_CYCLE_MS - (now - passStart);
    const mainAtRisk = remainingWall > 0 && cursor > 0 && (cursor / (now - passStart || 1)) * remainingWall < remaining * 1.2;
    const { mainCells, priorityMin, dueSessionMainTicks, offCycleTicks } = cycleMainCells(cycleStart, {
      pilotMarketSchedule, guaranteeDailyMain, offCycleMainMinutes, requestsPerMinute, sessionBudgetMinutes, mainAtRisk,
      msPerCellForTick, dueSessionTickCeiling,
    });
    const cellsThisCycle = Math.min(remaining, mainCells);
    cursor += cellsThisCycle;
    const cycleErrors = Math.round(cellsThisCycle * errorRate);
    const cycleFound = Math.round((cellsThisCycle - cycleErrors) * foundRate);
    processed += cellsThisCycle; errors += cycleErrors; found += cycleFound; noResult += cellsThisCycle - cycleErrors - cycleFound;
    cycles.push({ cycleStart, priorityMin, dueSessionMainTicks, offCycleTicks, cellsThisCycle, cursor });
    cycleStart += cycleMs; now = cycleStart;
  }
  const done = cursor >= mainTotal;
  return { elapsedMs: done ? now - passStart : null, cursor, mainTotal, cycles: cycles.length, done, log: cycles,
    counts: { processed, found, noResult, errors } };
}

export const hrs = ms => (ms == null ? null : +(ms / (60 * MIN)).toFixed(2));
export const reserveOf = elapsedMs => (elapsedMs == null ? -1 : +(1 - elapsedMs / MAIN_CYCLE_MS).toFixed(3));

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const MAIN_TOTAL = 23_952;
  const range = cellsPerTickRange();
  console.log(`cellsPerTick range (defensible, calendar-fallback+retry blended): ${range.low}-${range.high} cells/tick`);
  for (const scenario of [
    { name: 'current (both flags off)', pilotMarketSchedule: false, guaranteeDailyMain: false, offCycleMainMinutes: 0 },
    { name: 'guarantee only', pilotMarketSchedule: false, guaranteeDailyMain: true, offCycleMainMinutes: 0 },
    { name: 'pilot + guarantee', pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 0 },
    { name: 'pilot + guarantee + off-cycle(6m)', pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 6 },
    { name: 'pilot + guarantee + off-cycle(20m)', pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 20 },
  ]) {
    for (const [label, msPerCellForTick] of [['low rate', projectMainCellMs({ requestMs: 260, dbMs: 100, calendarFallback: true, retryCalls: 1 })],
      ['high rate', projectMainCellMs({ requestMs: 160, dbMs: 100 })]]) {
      const r = simulateMain24h({ mainTotal: MAIN_TOTAL, msPerCellForTick, ...scenario });
      console.log(`${scenario.name} [${label}]: ${r.done ? hrs(r.elapsedMs) + 'h' : '>' + hrs(3*24*60*MIN) + 'h (did not finish in 3d)'}  reserve=${r.done ? (reserveOf(r.elapsedMs)*100).toFixed(0)+'%' : 'n/a'}  found=${r.counts.found} noResult=${r.counts.noResult} errors=${r.counts.errors}`);
    }
  }
}
