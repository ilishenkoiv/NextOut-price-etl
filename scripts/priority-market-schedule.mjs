// Pilot market/time-of-day cadence for the PRICE-only priority refresh (roulette + window).
// Membership/rank/dest/dates are decided once a day by the existing daily selection — this
// module never touches that; it only decides, per origin and per 30-minute coordinator cycle,
// whether that origin's already-selected tickets are due for a price re-confirmation this cycle.
//
// APPROXIMATION: the only signal available is the DEPARTURE airport (origin), via the existing
// origin->Aviasales-market mapping (src/data/origin-markets.js). This is used as a stand-in for
// "the market/timezone the traveler is browsing from" — it is not, and cannot be, the viewer's
// actual location or timezone. Every result below carries `approximate:true` for this reason.
//
// All wall-clock math goes through Intl.DateTimeFormat with an explicit IANA timeZone, which
// resolves DST transitions correctly (no manual UTC-offset arithmetic, no fixed +1/+2h table).
import { CYCLE_MS } from './collection-schedule.mjs';
import { marketForOrigin } from '../src/data/origin-markets.js';

// DACH: Germany/Austria/Switzerland — one shared local clock (Europe/Berlin) for all three
// origin markets used here. Every other Aviasales market maps to the browser's own capital-city
// timezone; all are UTC or UTC+1 with the EU's shared DST calendar, so the daylight-savings
// transition dates line up across every zone below.
const MARKET_TIMEZONE = Object.freeze({
  de: 'Europe/Berlin', at: 'Europe/Berlin', ch: 'Europe/Berlin',
  gb: 'Europe/London', nl: 'Europe/Amsterdam', sk: 'Europe/Bratislava',
});
const DACH_MARKETS = new Set(['de', 'at', 'ch']);

const HOUR = 60;
// Peak window: local start-of-evening-browsing to local end-of-day. DACH starts an hour later
// than the rest of Europe per the owner's spec.
const PEAK_START_MIN = { dach: 19 * HOUR, other: 18 * HOUR };
const PEAK_END_MIN = 23 * HOUR;
const DAYTIME_START_MIN = 7 * HOUR;
const PEAK_INTERVAL_MS = 30 * 60_000;
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

export function marketTimeZone(market) {
  return MARKET_TIMEZONE[market] ?? MARKET_TIMEZONE.de; // unmapped market: fall back to the widest-covered zone
}

// One 30-minute coordinator cycle is "due" for an interval when its cycle id is a multiple of
// that interval, measured in cycles — anchored to the Unix epoch so it never drifts and needs no
// stored state. A 30-minute interval is due every cycle; a 2-hour interval, every 4th cycle.
export function dueForInterval(instant, intervalMs) {
  if (!(intervalMs > 0) || intervalMs % CYCLE_MS !== 0) throw new Error('Interval must be a positive multiple of CYCLE_MS');
  const cyclesPerInterval = intervalMs / CYCLE_MS;
  return Math.floor(instant / CYCLE_MS) % cyclesPerInterval === 0;
}

// The full policy for one origin at one instant. Pure; no I/O, no mutation.
export function priorityMarketPolicy(instant, origin) {
  if (!Number.isFinite(instant)) throw new Error('Invalid instant');
  const market = marketForOrigin(origin); // throws on an unmapped origin — same as every other caller of this shared mapping
  const timeZone = marketTimeZone(market);
  const dach = DACH_MARKETS.has(market);
  const minute = localMinuteOfDay(instant, timeZone);
  const peakStart = dach ? PEAK_START_MIN.dach : PEAK_START_MIN.other;
  const inPeak = minute >= peakStart && minute < PEAK_END_MIN;
  const inDaytime = minute >= DAYTIME_START_MIN && minute < peakStart;
  const inNight = !inPeak && !inDaytime; // 23:00–07:00, plus the DACH 18:00–19:00 sliver for non-DACH callers is impossible: peakStart<=19:00 always
  const phase = inPeak ? 'peak' : inDaytime ? 'daytime' : 'night';
  const intervalMs = inPeak ? PEAK_INTERVAL_MS : inDaytime ? DAYTIME_INTERVAL_MS : null;
  return {
    origin, market, timeZone, dach, minute, phase,
    intervalMs,
    mainOnly: inNight, // night: no mass priority refresh at all — MAIN/FAST/TAIL only
    approximate: true, // origin airport stands in for the traveler's actual market/timezone
  };
}

// Whether this ONE origin's already-selected tickets should be price-refreshed THIS cycle.
export function originDueThisCycle(instant, origin) {
  const policy = priorityMarketPolicy(instant, origin);
  if (policy.mainOnly) return false;
  return dueForInterval(instant, policy.intervalMs);
}

// Partitions a list of {origin,...} tickets into [due, notDueThisCycle] under the pilot policy.
// notDueThisCycle tickets keep their existing stored price/source_updated_at untouched this
// cycle — they are picked up again the next time their own origin's interval is due.
export function partitionTicketsByMarketSchedule(instant, tickets, originKey = t => t.origin) {
  const due = [], notDue = [];
  for (const ticket of tickets) (originDueThisCycle(instant, originKey(ticket)) ? due : notDue).push(ticket);
  return { due, notDue };
}
