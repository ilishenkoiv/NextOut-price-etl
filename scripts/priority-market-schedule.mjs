// Pilot time-of-day cadence for the PRICE-only priority refresh (roulette + window).
// Membership/rank/dest/dates are decided once a day by the existing daily selection — this
// module never touches that; it only decides, per 30-minute coordinator cycle, whether the
// already-selected tickets are due for a price re-confirmation this cycle.
//
// One shared clock for every origin — Europe/Berlin, the same for the whole catalogue (owner
// spec 2026-09-26). This replaced an earlier per-origin/market timezone approximation; `origin`
// is kept as a parameter only so existing call sites do not need to change, and is otherwise
// unused below.
//
// All wall-clock math goes through Intl.DateTimeFormat with an explicit IANA timeZone, which
// resolves DST transitions correctly (no manual UTC-offset arithmetic, no fixed +1/+2h table).
import { CYCLE_MS } from './collection-schedule.mjs';

const HOUR = 60;
const BERLIN_TIME_ZONE = 'Europe/Berlin';

// Daytime starts at local 07:00 every day of the week; night starts at local 23:00 every day.
// Only the EVENING window in between differs by weekday, per the owner's spec:
//   Mon-Sat: evening 18:00-23:00, 30-minute cadence; daytime 07:00-18:00, 2-hour cadence.
//   Sun:     evening 14:00-23:00, 60-minute cadence; daytime 07:00-14:00, 2-hour cadence.
// 23:00-07:00 every day: no priority refresh at all (mainOnly) — MAIN/FAST/TAIL are unaffected
// and keep running on their own 24/7 cadence regardless of this module.
//
// PILOT CAVEAT: these hours are a pilot hypothesis derived from general search/discovery
// activity patterns (when people browse/search travel content), NOT a measured or proven
// "purchase peak" for this product — no booking/conversion data was used to set them. Treat
// the 'evening' phase below as "the pilot's higher-cadence window", not as a validated claim
// about when users actually buy. Revisit with real product data before treating it as settled.
const DAYTIME_START_MIN = 7 * HOUR;
const NIGHT_START_MIN = 23 * HOUR;
const EVENING_START_MIN = { sunday: 14 * HOUR, weekday: 18 * HOUR };
const EVENING_INTERVAL_MS = { sunday: 60 * 60_000, weekday: 30 * 60_000 };
const DAYTIME_INTERVAL_MS = 2 * 60 * 60_000;

// Local {hour,minute} (0-1439 as minutes-since-midnight) at `instant` in `timeZone`, via Intl —
// correct across a DST transition because Intl resolves the IANA rule for that exact instant.
export function localMinuteOfDay(instant, timeZone) {
  if (!Number.isFinite(instant)) throw new Error('Invalid instant');
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB',
    { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(instant)).filter(p => p.type !== 'literal').map(p => [p.type, p.value]));
  return Number(parts.hour) * HOUR + Number(parts.minute);
}

// 0=Sunday..6=Saturday, resolved in `timeZone` for the given instant — DST-safe via Intl, same
// as localMinuteOfDay: the weekday can differ from UTC's around midnight in either direction.
export function localWeekday(instant, timeZone = BERLIN_TIME_ZONE) {
  if (!Number.isFinite(instant)) throw new Error('Invalid instant');
  const short = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date(instant));
  const index = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(short);
  if (index < 0) throw new Error(`Unresolvable weekday: ${short}`);
  return index;
}

// One 30-minute coordinator cycle is "due" for an interval when its cycle id is a multiple of
// that interval, measured in cycles — anchored to the Unix epoch so it never drifts and needs no
// stored state. A 30-minute interval is due every cycle; a 2-hour interval, every 4th cycle.
export function dueForInterval(instant, intervalMs) {
  if (!Number.isFinite(instant)) throw new Error('Invalid instant');
  if (!(intervalMs > 0) || intervalMs % CYCLE_MS !== 0) throw new Error('Interval must be a positive multiple of CYCLE_MS');
  const cyclesPerInterval = intervalMs / CYCLE_MS;
  return Math.floor(instant / CYCLE_MS) % cyclesPerInterval === 0;
}

// The full policy at one instant. Pure; no I/O, no mutation. `origin` is accepted but unused —
// see the module comment above.
export function priorityMarketPolicy(instant, origin) {
  if (!Number.isFinite(instant)) throw new Error('Invalid instant');
  const timeZone = BERLIN_TIME_ZONE;
  const minute = localMinuteOfDay(instant, timeZone);
  const weekday = localWeekday(instant, timeZone);
  const sunday = weekday === 0;
  const eveningStart = sunday ? EVENING_START_MIN.sunday : EVENING_START_MIN.weekday;
  const inEvening = minute >= eveningStart && minute < NIGHT_START_MIN;
  const inDaytime = minute >= DAYTIME_START_MIN && minute < eveningStart;
  const inNight = !inEvening && !inDaytime; // 23:00-07:00
  const phase = inEvening ? 'evening' : inDaytime ? 'daytime' : 'night';
  const intervalMs = inEvening ? (sunday ? EVENING_INTERVAL_MS.sunday : EVENING_INTERVAL_MS.weekday)
    : inDaytime ? DAYTIME_INTERVAL_MS : null;
  return {
    origin, timeZone, weekday, sunday, minute, phase,
    intervalMs,
    mainOnly: inNight, // night: no mass priority refresh at all — MAIN/FAST/TAIL only
  };
}

// Whether the already-selected tickets should be price-refreshed THIS cycle.
export function originDueThisCycle(instant, origin) {
  const policy = priorityMarketPolicy(instant, origin);
  if (policy.mainOnly) return false;
  return dueForInterval(instant, policy.intervalMs);
}

// Partitions a list of {origin,...} tickets into [due, notDueThisCycle] under the pilot policy.
// notDueThisCycle tickets keep their existing stored price/source_updated_at untouched this
// cycle — they are picked up again the next time the shared cadence is due.
export function partitionTicketsByMarketSchedule(instant, tickets, originKey = t => t.origin) {
  const due = [], notDue = [];
  for (const ticket of tickets) (originDueThisCycle(instant, originKey(ticket)) ? due : notDue).push(ticket);
  return { due, notDue };
}
