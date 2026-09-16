// Pure shared carousel window planning, extracted unchanged from the deployed collector.
const pad2 = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
const addDays = (iso, n) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return isoDay(d); };
const addMonths = (iso, n) => {
  const d = new Date(`${iso}T00:00:00Z`); const day = d.getUTCDate();
  d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last)); return isoDay(d);
};
const dow = (iso) => new Date(`${iso}T00:00:00Z`).getUTCDay(); // 0=Sun … 6=Sat
const nightsBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
const isWeekend = (iso) => { const w = dow(iso); return w === 0 || w === 6; };

// §short-window schemes by endpoint weekday — VERBATIM from lib/breakWindows.ts (the carousel's set,
// one window per holiday block, NOT the collector's vacation/connecting fan-out).
const SHORT_SCHEMES = { 1: [[-3, 0]], 2: [[-4, 0]], 3: [[-1, 4], [-5, 0]], 4: [[-1, 3]], 5: [[-1, 2]], 0: [], 6: [] };
const MIN_LEAD_DAYS = 10;
const MAX_WINDOW_NIGHTS = 14;
// §weekend-around — corridor windows AROUND ordinary weekends. Built ONLY for weekends whose Friday
// sits within CORRIDOR_HORIZON_DAYS of the run date; farther weekends keep just their exact 'weekend'
// window. A corridor trip is at most CORRIDOR_MAX_NIGHTS nights and MUST contain both weekend nights.
const CORRIDOR_HORIZON_DAYS = 56; // eight weeks from the run date
const CORRIDOR_MAX_NIGHTS = 7;    // a corridor trip is at most seven nights
// §weekend-around is DEFERRED — NOT in this release. The corridor-building block below is kept intact
// for a future turn-on; this flag only gates whether computeAllWindows actually EMITS those windows.
// Default OFF, so the ordinary sweep builds exactly the pre-corridor set (weekend ∪ holiday). Turn on
// with WEEKEND_AROUND=1. (window_kind is still stamped on the weekend/holiday rows — see the upsert.)


function buildBlocks(holidays) {
  const blocks = [];
  for (const h of holidays) {
    const prev = blocks.length ? blocks[blocks.length - 1] : null;
    if (prev) {
      let mergeable = true;
      for (let d = addDays(prev.last, 1); d < h; d = addDays(d, 1)) { if (!isWeekend(d)) { mergeable = false; break; } }
      if (mergeable) { prev.last = h; continue; }
    }
    blocks.push({ first: h, last: h });
  }
  return blocks;
}

// Full window set for the horizon: holiday windows for EVERY supported region ∪ weekends, deduped by
// (start|end). Mirrors computeBreakWindows across all regions, first-writer-wins per date pair.
export function computeAllWindows(holidays, regions, today, { horizonMonths = 6, weekendAround = false } = {}) {
  const minStart = addDays(today, MIN_LEAD_DAYS);
  const maxStart = addMonths(today, horizonMonths);
  const chosen = new Map();
  // enforceLead=false lets a corridor departure sit up to four days before the (lead-valid) Friday
  // without being trimmed by MIN_LEAD_DAYS; the ceiling + dedup still apply to every window.
  const add = (w, { enforceLead = true } = {}) => {
    if (enforceLead && (w.start < minStart || w.start > maxStart)) return;
    if (w.nights < 1 || w.nights > MAX_WINDOW_NIGHTS) return;
    const k = `${w.start}|${w.end}`;
    if (!chosen.has(k)) chosen.set(k, w);
  };
  for (const region of regions) {
    const country = region.slice(0, 2);
    const dates = [...new Set(
      holidays.filter((h) => h.country === country && (h.level === 'country' || h.subdivision_code === region)).map((h) => h.date),
    )].sort();
    for (const b of buildBlocks(dates)) {
      const starts = SHORT_SCHEMES[dow(b.first)];
      const rets = SHORT_SCHEMES[dow(b.last)];
      if (!starts.length || !rets.length) continue;
      const n = Math.max(starts.length, rets.length);
      let best = null;
      for (let i = 0; i < n; i += 1) {
        const dep = addDays(b.first, starts[i % starts.length][0]);
        const ret = addDays(b.last, rets[i % rets.length][1]);
        if (!best || dep < best.dep) best = { dep, ret };
      }
      if (best) add({ start: best.dep, end: best.ret, nights: nightsBetween(best.dep, best.ret), kind: 'holiday' });
    }
  }
  for (let iso = minStart; iso <= maxStart; iso = addDays(iso, 1)) {
    if (dow(iso) === 5) add({ start: iso, end: addDays(iso, 2), nights: 2, kind: 'weekend' });
  }
  // §weekend-around — for each ordinary weekend within the corridor horizon, build every trip that
  // CONTAINS both weekend nights (Fri & Sat): departure in [Fri-4 … Fri], return in [Sun … Sun+4],
  // length ≤ CORRIDOR_MAX_NIGHTS. That is 19 date-pairs; the exact Fri→Sun (2n) is already the
  // 'weekend' window and is skipped here, so each eligible weekend contributes 18 corridor windows.
  // Capped at maxStart too, so a corridor weekend always has its exact window even under a short
  // horizonMonths override.
  // DEFERRED: gated behind weekendAround (default OFF). The block stays for a future turn-on;
  // with the flag off it never runs, so the emitted set is exactly weekend ∪ holiday.
  if (weekendAround) {
    const corridorMax = addDays(today, CORRIDOR_HORIZON_DAYS);
    const corridorEnd = corridorMax < maxStart ? corridorMax : maxStart;
    for (let fri = minStart; fri <= corridorEnd; fri = addDays(fri, 1)) {
      if (dow(fri) !== 5) continue;
      for (let dep = -4; dep <= 0; dep += 1) {
        for (let ret = 2; ret <= 6; ret += 1) {
          if (dep === 0 && ret === 2) continue; // the exact Fri→Sun weekend — never duplicated here
          const start = addDays(fri, dep);
          const end = addDays(fri, ret);
          const nights = nightsBetween(start, end);
          if (nights > CORRIDOR_MAX_NIGHTS) continue; // both weekend nights sit inside by construction
          add({ start, end, nights, kind: 'weekend_around' }, { enforceLead: false });
        }
      }
    }
  }
  return [...chosen.values()].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
}
