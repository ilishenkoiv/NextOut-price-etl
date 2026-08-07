// scripts/break-windows.mjs — build the run's "break windows" (holiday bridges, vacation stretches,
// weekend getaways) from a set of applicable holiday dates. PURE: no I/O, no Travelpayouts calls,
// nothing runs on import — so it is unit-testable in isolation (fetch-prices.mjs runs main() on
// import and cannot be). fetch-prices.mjs imports { isoDay, buildBreakWindows } from here; adding a
// window costs ZERO partner requests — selectCombo re-tags offers already fetched, keeping any whose
// `${departure_at}|${nights}` is in the returned keySet, exactly as before.
//
// The schemes (§break-windows), all returning on a NON-workday (a holiday or a Sunday — never the
// plain Monday the old code produced for Thu/Fri):
//   (1) склейка — holidays with only weekends (or nothing) between them fold into ONE block.
//   (2) short window, by the block's first/last weekday (see SHORT_SCHEMES).
//   (3) vacation — up to four per block: start {day before, previous Friday} × return {day after,
//       Sunday next week}.
//   (4) connect two blocks ≤7 days apart — one span first-start → second-return (closes Christmas
//       with no Christmas-specific code).
//   (5) ceiling: 1 ≤ nights ≤ 14.
//   (6) ordinary weekends — Fri→Sun, 2 nights.
//   (7) dedup by (departure, return).

// ── date helpers (UTC, date-only ISO 'YYYY-MM-DD') ───────────────────────────────
export const pad2 = (n) => String(n).padStart(2, '0');
export const isoDay = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
export function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return isoDay(d);
}
export function dowUtc(iso) { return new Date(`${iso}T00:00:00Z`).getUTCDay(); } // 0=Sun … 6=Sat
const nightsBetween = (dep, ret) =>
  Math.round((Date.parse(`${ret}T00:00:00Z`) - Date.parse(`${dep}T00:00:00Z`)) / 86400000);
const isWeekend = (iso) => { const w = dowUtc(iso); return w === 0 || w === 6; };

export const MAX_WINDOW_NIGHTS = 14; // §ceiling — drop windows longer than this
const MIN_WINDOW_NIGHTS = 1;
const CONNECT_MAX_GAP_DAYS = 7;      // two blocks join when no more than this far apart

// §short-window schemes, keyed by weekday (0=Sun … 6=Sat). Each entry is a list of
// [startOffset, returnOffset] PAIRS in days: departure = anchor + startOffset, return =
// anchor + returnOffset. For a single-day block the anchor is that day and the pairs ARE the table:
//   Mon → Fri→Mon (3n)   Tue → Fri→Tue (4n)   Wed → Tue→Sun (5n) & Fri→Wed (5n)
//   Thu → Wed→Sun (4n)   Fri → Thu→Sun (3n)   Sat/Sun → none
// The return always lands on the holiday itself or a Sunday — fixing the old Thu/Fri → Monday
// (a workday) return.
const SHORT_SCHEMES = {
  1: [[-3, 0]],           // Mon — Fri→Mon
  2: [[-4, 0]],           // Tue — Fri→Tue
  3: [[-1, +4], [-5, 0]], // Wed — Tue→Sun AND Fri→Wed
  4: [[-1, +3]],          // Thu — Wed→Sun
  5: [[-1, +2]],          // Fri — Thu→Sun
  0: [],                  // Sun — no window of its own
  6: [],                  // Sat — no window of its own
};

// Merge holidays into blocks: two holidays join when every day strictly between them is a weekend
// (or they are adjacent) — "only weekends or nothing between". A block is [first, last] HOLIDAY;
// bounding weekends only permit the merge and are not endpoints, so the endpoints' weekdays drive
// the short-window scheme. `holidays` must be sorted ascending.
export function buildBlocks(holidays) {
  const blocks = [];
  for (const h of holidays) {
    const prev = blocks.length ? blocks[blocks.length - 1] : null;
    if (prev) {
      let mergeable = true;
      for (let d = addDaysIso(prev.last, 1); d < h; d = addDaysIso(d, 1)) {
        if (!isWeekend(d)) { mergeable = false; break; }
      }
      if (mergeable) { prev.last = h; continue; }
    }
    blocks.push({ first: h, last: h });
  }
  return blocks;
}

// The Friday strictly before `iso` (a Friday itself → the Friday a week earlier).
function previousFriday(iso) {
  let d = addDaysIso(iso, -1);
  while (dowUtc(d) !== 5) d = addDaysIso(d, -1);
  return d;
}
// The Sunday of the week AFTER iso's week — the "next week's Sunday" vacation return.
function sundayNextWeek(iso) {
  const toSun = (7 - dowUtc(iso)) % 7; // 0 when iso is already Sunday
  return addDaysIso(iso, toSun + 7);
}

// Build every break window whose DEPARTURE sits in [fromIso, toIso]. `holidayDates` is an iterable
// of ISO day strings already filtered to the origins' regions. Returns the selection keySet plus a
// per-kind breakdown for the run summary.
export function buildBreakWindows(holidayDates, fromIso, toIso) {
  const holidays = [...holidayDates].filter((h) => typeof h === 'string').sort();
  const blocks = buildBlocks(holidays);

  // `${dep}|${ret}` → { nights, kind }. First writer WINS the kind, so emission order encodes the
  // priority the summary reports by: short → vacation → connecting → weekend.
  const chosen = new Map();
  const add = (dep, ret, kind) => {
    if (dep < fromIso || dep > toIso) return;                            // departure must be in horizon
    const nights = nightsBetween(dep, ret);
    if (nights < MIN_WINDOW_NIGHTS || nights > MAX_WINDOW_NIGHTS) return; // §ceiling + ≥1 night
    const k = `${dep}|${ret}`;
    if (!chosen.has(k)) chosen.set(k, { nights, kind });
  };

  // (2) short — start scheme from the FIRST day's weekday, return scheme from the LAST day's, zipped
  // index-wise (cycling the shorter). A single-day block reproduces the table exactly (Wed → two
  // windows); a merged block pairs first-day starts with last-day returns.
  for (const b of blocks) {
    const starts = SHORT_SCHEMES[dowUtc(b.first)];
    const rets = SHORT_SCHEMES[dowUtc(b.last)];
    if (!starts.length || !rets.length) continue; // a Sat/Sun endpoint gives no short window of its own
    const n = Math.max(starts.length, rets.length);
    for (let i = 0; i < n; i += 1) {
      add(addDaysIso(b.first, starts[i % starts.length][0]), addDaysIso(b.last, rets[i % rets.length][1]), 'short');
    }
  }

  // (3) vacation — up to four per block. Emitted minimal → after-extension → before-extension →
  // both, so when the ceiling trims, priority is short (already placed) → vacation-after → vacation-before.
  for (const b of blocks) {
    const dayBefore = addDaysIso(b.first, -1);
    const prevFri = previousFriday(b.first);
    const dayAfter = addDaysIso(b.last, 1);
    const sunNext = sundayNextWeek(b.last);
    add(dayBefore, dayAfter, 'vacation'); // minimal (a day off before, back right after)
    add(dayBefore, sunNext, 'vacation');  // extend the return — vacation AFTER
    add(prevFri, dayAfter, 'vacation');   // extend the start — vacation BEFORE
    add(prevFri, sunNext, 'vacation');    // both
  }

  // (4) connect two blocks ≤7 days apart — one span from the first block's start points to the
  // second block's return points. Closes the Christmas–New-Year gap; the ceiling keeps only the
  // reachable spans. Consecutive pairs only (never block 1 → block 3).
  for (let i = 0; i + 1 < blocks.length; i += 1) {
    const a = blocks[i], c = blocks[i + 1];
    if (nightsBetween(a.last, c.first) > CONNECT_MAX_GAP_DAYS) continue;
    const starts = [addDaysIso(a.first, -1), previousFriday(a.first)];
    const rets = [addDaysIso(c.last, 1), sundayNextWeek(c.last)];
    for (const s of starts) for (const r of rets) add(s, r, 'connecting');
  }

  // (6) ordinary weekends — Fri→Sun, 2 nights — unchanged.
  for (let iso = fromIso; iso <= toIso; iso = addDaysIso(iso, 1)) {
    if (dowUtc(iso) === 5) add(iso, addDaysIso(iso, 2), 'weekend');
  }

  // keySet drives selectCombo's O(1) check `${departure_at}|${nights}`. count + per-kind breakdown
  // feed the run summary. First-writer-wins partitions the map, so short+vacation+connecting+weekend
  // === count.
  const keySet = new Set();
  let short = 0, vacation = 0, connecting = 0, weekend = 0;
  for (const [pair, v] of chosen) {
    keySet.add(`${pair.split('|')[0]}|${v.nights}`);
    if (v.kind === 'short') short += 1;
    else if (v.kind === 'vacation') vacation += 1;
    else if (v.kind === 'connecting') connecting += 1;
    else weekend += 1;
  }
  return { keySet, count: chosen.size, short, vacation, connecting, weekend };
}
