// Cycle-by-cycle capacity model for a full MAIN sweep under the CURRENT 5-minute
// supabase-cron trigger architecture (single serialized runner, one due session of
// COLLECTION_SESSION_MINUTES per 30-min priority cycle, optional off-cycle MAIN top-up in the
// remaining minutes before the next due cycle). This supersedes the older 235-minute/`7 */4`
// session model in collection-daily-sim.mjs, which predates the single-coordinator-schedule and
// supabase-cron-trigger changes and no longer reflects the deployed trigger cadence.
//
// Real, imported constants/functions drive every number that matters (SLOTS proportions,
// CYCLE_MS, PRIORITY_MAX_CYCLE_MS, OFF_CYCLE_SAFETY_MARGIN_MS, offCycleMainBudget,
// originDueThisCycle over the actual 22-origin catalogue) — only the per-request latency and the
// realized cells/request ratio are supplied as measured/assumed inputs. This is an analytical
// (not discrete-event) per-cycle budget accountant: each cycle's minute allocation is computed
// from the real slot/priority/off-cycle formulas, not replayed through SequentialSchedule's
// internal state machine. See collection-daily-sim.mjs for a discrete-event cross-check of the
// underlying engine on a representative cycle.
import { SLOTS, CYCLE_MS, PRIORITY_MAX_CYCLE_MS, MAIN_CYCLE_MS, offCycleMainBudget } from './collection-schedule.mjs';
import { originDueThisCycle } from './priority-market-schedule.mjs';
import { ORIGINS_ALL } from '../src/data/origins.js';

const MIN = 60_000;
// Mirrors run-collection.mjs OFF_CYCLE_SAFETY_MARGIN_MS exactly (not re-imported to avoid pulling
// in @supabase/supabase-js for a pure capacity model); collection-workflows.test.mjs asserts the
// two stay in lockstep.
export const OFF_CYCLE_SAFETY_MARGIN_MS = 90_000;

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

const nominalSlotMinutes = task => {
  const slot = SLOTS.find(s => s.task === task);
  return slot.to - slot.from;
};

// One 30-minute cycle: the due session covers the whole cycle (SLOTS run against wall-clock
// minutes, not session-relative offsets); an optional off-cycle trigger tops up MAIN in the
// runway between the due session's own budget and the next due cycle, bounded by
// offCycleMainBudget's safety margin exactly as run-collection.mjs enforces it.
function cycleMainMinutes(cycleStart, { pilotMarketSchedule, guaranteeDailyMain, offCycleMainMinutes,
  requestsPerMinute, sessionBudgetMinutes, mainAtRisk }) {
  const priorityMin = priorityMinutesThisCycle(cycleStart, { pilotMarketSchedule, requestsPerMinute });
  const priorityOverrun = Math.max(0, priorityMin - nominalSlotMinutes('priority'));
  const cappedPriorityOverrun = Math.min(priorityOverrun, PRIORITY_MAX_CYCLE_MS / MIN - nominalSlotMinutes('priority'));
  const fastMin = nominalSlotMinutes('fast');
  const tailMin = guaranteeDailyMain && mainAtRisk ? 0 : nominalSlotMinutes('tail'); // tail yields to main
  const maintMin = nominalSlotMinutes('maintenance');
  const reserveMin = nominalSlotMinutes('reserve'); // unclaimed by any adapter today; reachable only off-cycle
  const dueSessionMainMin = Math.max(0, nominalSlotMinutes('main') - cappedPriorityOverrun);
  // Everything the due session itself does not use (reserve slot, and slack if the due session's
  // own budget is below the 30-minute cycle) is only reachable through a SEPARATE off-cycle
  // trigger, which must still respect the real safety margin before the next due cycle.
  const dueSessionUsedMin = Math.min(sessionBudgetMinutes, nominalSlotMinutes('priority') + priorityMin - priorityOverrun + fastMin + dueSessionMainMin + tailMin + maintMin);
  const cycleEnd = cycleStart + CYCLE_MS;
  const offCycleStart = cycleStart + dueSessionUsedMin * MIN;
  let offCycleMainMin = 0;
  if (offCycleMainMinutes > 0 && offCycleStart < cycleEnd) {
    const stopAt = offCycleMainBudget(offCycleStart, { safetyMarginMs: OFF_CYCLE_SAFETY_MARGIN_MS, maxSessionMs: offCycleMainMinutes * MIN });
    if (stopAt) offCycleMainMin = Math.max(0, (stopAt - offCycleStart) / MIN - 0.5 /* checkout+claim overhead */);
  }
  return { mainMin: dueSessionMainMin + Math.max(0, offCycleMainMin), priorityMin };
}

// Runs a full simulated day (48 cycles) tracking a single MAIN pass's cursor. `mainRate` is
// cells committed per realized MAIN minute (from measured/assumed request latency and
// MAIN_REQUIRED_PROVIDER_CALLS=4 mandatory calls/cell). Returns elapsed ms to completion, or null
// if it does not finish within `maxDays`.
export function simulateMain24h({ mainTotal, mainRate, requestsPerMinute = 89, sessionBudgetMinutes = 25,
  pilotMarketSchedule = false, guaranteeDailyMain = false, offCycleMainMinutes = 0, startInstant = 0, maxDays = 3 }) {
  let cursor = 0; let now = startInstant; const passStart = startInstant;
  const cycleMs = CYCLE_MS;
  let cycleStart = Math.floor(now / cycleMs) * cycleMs;
  const cycles = [];
  while (cursor < mainTotal && now - passStart < maxDays * 24 * 60 * MIN) {
    const remaining = mainTotal - cursor;
    const remainingWall = MAIN_CYCLE_MS - (now - passStart);
    const mainAtRisk = remainingWall > 0 && cursor > 0 && (cursor / (now - passStart || 1)) * remainingWall < remaining * 1.2;
    const { mainMin, priorityMin } = cycleMainMinutes(cycleStart, {
      pilotMarketSchedule, guaranteeDailyMain, offCycleMainMinutes, requestsPerMinute, sessionBudgetMinutes, mainAtRisk,
    });
    const cellsThisCycle = Math.max(0, Math.round(mainMin * mainRate));
    cursor = Math.min(mainTotal, cursor + cellsThisCycle);
    cycles.push({ cycleStart, mainMin, priorityMin, cellsThisCycle, cursor });
    cycleStart += cycleMs; now = cycleStart;
  }
  const done = cursor >= mainTotal;
  return { elapsedMs: done ? now - passStart : null, cursor, mainTotal, cycles: cycles.length, done, log: cycles };
}

export const hrs = ms => (ms == null ? null : +(ms / (60 * MIN)).toFixed(2));
export const reserveOf = elapsedMs => (elapsedMs == null ? -1 : +(1 - elapsedMs / MAIN_CYCLE_MS).toFixed(3));

import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const MAIN_TOTAL = 23_952;
  const RATE = 89 / 4; // cells/min at MAIN's 4 mandatory requests/cell, no calendar fallback/retry
  for (const scenario of [
    { name: 'current (both flags off)', pilotMarketSchedule: false, guaranteeDailyMain: false, offCycleMainMinutes: 0 },
    { name: 'guarantee only', pilotMarketSchedule: false, guaranteeDailyMain: true, offCycleMainMinutes: 0 },
    { name: 'pilot + guarantee', pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 0 },
    { name: 'pilot + guarantee + off-cycle(3m)', pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 3 },
    { name: 'pilot + guarantee + off-cycle(4m)', pilotMarketSchedule: true, guaranteeDailyMain: true, offCycleMainMinutes: 4 },
  ]) {
    const r = simulateMain24h({ mainTotal: MAIN_TOTAL, mainRate: RATE, requestsPerMinute: 89, ...scenario });
    console.log(`${scenario.name}: ${r.done ? hrs(r.elapsedMs) + 'h' : '>' + hrs(3*24*60*MIN) + 'h (did not finish in 3d)'}  reserve=${r.done ? (reserveOf(r.elapsedMs)*100).toFixed(0)+'%' : 'n/a'}`);
  }
}
