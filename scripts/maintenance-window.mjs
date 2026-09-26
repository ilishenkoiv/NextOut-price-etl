// Pure scheduling rules for the nightly maintenance block (owner spec 2026-09-26). No I/O.
//
// The block replaces the old "one turn every 30-minute cycle, all day" maintenance rotation
// with a single once-per-Berlin-day window: due at 03:00, must finish (or give up for the
// night) by 05:45, so it is always settled well before the 06:00 daily selection. It is capped
// at MAINTENANCE_BLOCK_MAX_MS of actual work per night regardless of how early it starts.
import { localMinuteOfDay } from './priority-market-schedule.mjs';

const BERLIN_TIME_ZONE = 'Europe/Berlin';
export const MAINTENANCE_DUE_MINUTES = 3 * 60;       // 03:00
export const MAINTENANCE_STOP_BY_MINUTES = 5 * 60 + 45; // 05:45 — must be settled before 06:00 selection
export const MAINTENANCE_BLOCK_MAX_MS = 15 * 60_000;

export function berlinDay(instant) {
  if (!Number.isFinite(instant)) throw new Error('Invalid instant');
  return new Date(instant).toLocaleDateString('en-CA', { timeZone: BERLIN_TIME_ZONE });
}

// Whether the block should be attempted THIS instant. `checkpoint` is the maintenance job's own
// persisted state (or null/undefined on the very first call): { day, blockDone, blockElapsedMs }.
// Independent of the scheduling engine's own (UTC-day) job-id bookkeeping — this owns "once per
// Berlin day" itself, so it is unaffected by the engine preserving the checkpoint indefinitely
// across UTC-day rollovers (see collection-adapters.mjs's maintenance handler).
export function maintenanceDue(instant, checkpoint) {
  const minute = localMinuteOfDay(instant, BERLIN_TIME_ZONE);
  if (minute < MAINTENANCE_DUE_MINUTES || minute >= MAINTENANCE_STOP_BY_MINUTES) return false;
  const today = berlinDay(instant);
  if (checkpoint?.day === today && checkpoint?.blockDone) return false;
  return true;
}

// Whether the CURRENT block (started tonight) must stop now: either its own 15-minute work
// budget is exhausted (`elapsedMs`, real time already spent tonight), or the 05:45 wall-clock
// cutoff has arrived. Both are logged and treated identically — the remainder is not attempted
// again until tomorrow's 03:00.
export function maintenanceMustStop(instant, elapsedMs) {
  const minute = localMinuteOfDay(instant, BERLIN_TIME_ZONE);
  if (minute >= MAINTENANCE_STOP_BY_MINUTES) return true;
  return (elapsedMs ?? 0) >= MAINTENANCE_BLOCK_MAX_MS;
}

// The first calendar day of a quarter (Jan/Apr/Jul/Oct 1st), Berlin — mirrors
// .github/workflows/cleanup-price-storage.yml's cron ('2 0 1 1,4,7,10 *').
export function isQuarterlyMaintenanceDay(todayYmd) {
  const match = /^\d{4}-(\d{2})-(\d{2})$/.exec(String(todayYmd));
  if (!match) return false;
  return ['01', '04', '07', '10'].includes(match[1]) && match[2] === '01';
}
