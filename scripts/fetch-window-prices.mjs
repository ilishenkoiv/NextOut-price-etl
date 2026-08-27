// scripts/fetch-window-prices.mjs — dedicated price sweep for the carousel's break windows,
// ONE home airport per run (the workflow fans it out into 20 sequential parts).
//
// WHAT IT COLLECTS
//   • horizon 6 months; windows = holiday bridges across ALL calendar regions (deduped by dates)
//     PLUS ordinary Fri→Sun weekends — the SAME set the app carousel builds (lib/breakWindows.ts).
//     Windows are computed FROM THE DATABASE calendar (public_holidays + origin_regions), never a
//     hard-coded list.
//   • BOTH flight variants per destination: direct (non-stop) and any (incl. connections).
//   • strictly the window's exact dates: departure = window start, return = window end.
//   • DESTINATIONS ARE NARROWED BY HISTORY: only the TOP_DESTS (50) catalogue destinations that
//     have most often yielded a fare for THIS origin — ranked by their own window_prices row count,
//     so no find-counter is stored anywhere new. Destinations that never produced a fare are kept
//     for a PERIODIC FULL PASS (monthly), not dropped, so a newly opened route is still discovered.
//
// WHERE IT WRITES
//   public.window_prices (migration 20260810120000_window_prices.sql) — its OWN table, so it never
//   collides with the main collector's offers/prune. One row per (origin, dest, flight_type,
//   departure_at, return_at): the cheapest real fare for those exact dates.
//   public.window_price_misses (migration 20260818120000_window_price_misses.sql) — the mirror log of
//   probes that stored NO fare ('empty' | 'http_error' | 'network_error'), on the SAME 5-part key.
//   Upserted on a miss (last outcome wins, never piled up); DELETED for a key the instant a real fare
//   lands, so a stale "no fare" mark never lingers. window_prices is still left untouched on a miss.
//
// RULES THAT MUST HOLD
//   • NEVER overwrite a known price with an empty answer — a refusal / error / empty response writes
//     nothing, the previously collected row stays.
//   • Pace at 80% of the partner's allowed rate, like the main collector: v3/prices_for_dates limit
//     600/min → target 480/min → 125 ms. If a response header declares a lower limit, slow to 80%
//     of THAT.
//   • Log headers carrying the remaining quota (X-Rate-Limit-Remaining).
//   • Partial result survives a crash: fares are flushed per destination (and whenever the buffer
//     fills), and a window_price_progress row is written after each destination, so a crash loses at
//     most the current destination's in-flight buffer. Each airport part is also an independent job.
//
// RUN (manual only — the workflow has no schedule):
//   ORIGIN=FRA TP_TOKEN=... SUPABASE_SERVICE_KEY=... node scripts/fetch-window-prices.mjs
//
// ENV:
//   ORIGIN               — home airport IATA for THIS part (required).
//   TP_TOKEN             — Travelpayouts token (required, SECRET).
//   SUPABASE_SERVICE_KEY — Supabase service-role key, writes past RLS (required, SECRET).
//   SUPABASE_URL         — project URL (public, NOT a secret; default below).
//   HORIZON_MONTHS       — override the 6-month horizon (default 6).
//   PLAN_DATE            — override "today" (YYYY-MM-DD) for a reproducible window set.
//   TOP_DESTS            — history-narrowed destinations asked per origin (default 50).
//   FULL_SWEEP           — '1' force a full catalogue pass, '0' force the narrow list;
//                          default: automatic monthly pass (see FULL_SWEEP_DOM).
//   FULL_SWEEP_DOM       — day-of-month cutoff for the automatic full pass (default 3).
import { createClient } from '@supabase/supabase-js';

const TP_TOKEN = process.env.TP_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xpalogebawoljlafsafs.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const ORIGIN = (process.env.ORIGIN || '').trim().toUpperCase();
const HORIZON_MONTHS = Number(process.env.HORIZON_MONTHS) || 6;

if (!TP_TOKEN || !SUPABASE_SERVICE_KEY || !ORIGIN) {
  console.error('Missing required input:');
  if (!ORIGIN) console.error('  • ORIGIN (home airport IATA) is not set.');
  if (!TP_TOKEN) console.error('  • TP_TOKEN (Travelpayouts token) is not set.');
  if (!SUPABASE_SERVICE_KEY) console.error('  • SUPABASE_SERVICE_KEY (Supabase service-role key) is not set.');
  console.error('  e.g.  ORIGIN=FRA TP_TOKEN=... SUPABASE_SERVICE_KEY=... node scripts/fetch-window-prices.mjs');
  process.exit(1);
}

// Confirm the key is service_role (anon would be denied by RLS on write) — same guard as the sibling
// scripts. Warn only; the write itself will fail loudly if the role is wrong.
function keyRole(key) {
  try {
    const seg = key.split('.')[1];
    if (!seg) return '(opaque non-JWT key)';
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')).role || '(no role claim)';
  } catch { return '(unreadable)'; }
}
if (keyRole(SUPABASE_SERVICE_KEY) !== 'service_role') {
  console.warn(`WARNING: SUPABASE_SERVICE_KEY role = "${keyRole(SUPABASE_SERVICE_KEY)}" (expected "service_role") — writes will likely be denied.`);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

// ── date helpers (UTC, date-only ISO) — same rules as lib/breakWindows.ts ─────────────────────────
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// "Today" in Europe/Berlin (the app anchors the horizon there). PLAN_DATE is resolved separately in
// main() so the same value drives both the window set and the progress markers.
function berlinToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' }); // 'YYYY-MM-DD'
}

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
const WEEKEND_AROUND_ENABLED = (process.env.WEEKEND_AROUND || '').trim() === '1';

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
function computeAllWindows(holidays, regions, today) {
  const minStart = addDays(today, MIN_LEAD_DAYS);
  const maxStart = addMonths(today, HORIZON_MONTHS);
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
  // HORIZON_MONTHS override.
  // DEFERRED: gated behind WEEKEND_AROUND_ENABLED (default OFF). The block stays for a future turn-on;
  // with the flag off it never runs, so the emitted set is exactly weekend ∪ holiday.
  if (WEEKEND_AROUND_ENABLED) {
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

// ── paginated reads (PostgREST caps a .select() at 1000 rows silently → always .range()+.order()) ──
async function loadAll(table, columns, orderCols, apply) {
  const PAGE = 1000; const out = [];
  for (let from = 0; ; from += PAGE) {
    let q = supabase.from(table).select(columns);
    for (const c of orderCols) q = q.order(c, { ascending: true });
    if (apply) q = apply(q);
    const { data, error } = await q.range(from, from + PAGE - 1);
    if (error) throw new Error(`${table} read failed: ${error.code || ''} ${error.message}`);
    out.push(...data);
    if (data.length < PAGE) break;
  }
  return out;
}

// ── rate pacing: 80% of the allowed rate; adapt down if a header declares a lower ceiling ─────────
const LIMIT_PER_MIN = 600;         // v3/prices_for_dates declared ceiling
const SAFETY = 0.8;                // 80% of allowed, like the main collector
let intervalMs = Math.ceil(60000 / (LIMIT_PER_MIN * SAFETY)); // 125 ms
let quota = { limit: null, remaining: null, reset: null };
function noteRateHeaders(headers) {
  const num = (v) => { if (v == null) return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
  const limit = num(headers.get('x-rate-limit'));
  quota = { limit, remaining: num(headers.get('x-rate-limit-remaining')), reset: num(headers.get('x-rate-limit-reset')) };
  if (limit && limit > 0 && limit < LIMIT_PER_MIN) {
    const slower = Math.ceil(60000 / (limit * SAFETY));
    if (slower > intervalMs) intervalMs = slower; // only ever slow down
  }
}
function quotaHeader(prefix) {
  console.log(`── ${prefix} · quota remaining ${quota.remaining ?? '—'}/${quota.limit ?? '—'} · reset ${quota.reset ?? '—'} · pace ${intervalMs}ms`);
}

// ── one exact-date query, one variant. Returns { fare, outcome, detail } and NEVER writes:
//   • fare set, outcome null       — cheapest matching offer on the exact dates;
//   • fare null, outcome 'empty'   — HTTP 200 + success, but no offer on the exact dates (detail '');
//   • fare null, outcome 'http_error'   — non-2xx, unparseable body, or success=false (detail carries it);
//   • fare null, outcome 'network_error'— the request never completed / timed out (detail carries it).
// The caller decides what to persist; on any non-fare outcome window_prices is left untouched.
const TIMEOUT_MS = 8000;
async function fetchWindowFare(dest, start, end, direct) {
  const url =
    `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?origin=${ORIGIN}` +
    `&destination=${dest}&departure_at=${start}&return_at=${end}&direct=${direct}` +
    `&currency=eur&limit=500&token=${TP_TOKEN}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    noteRateHeaders(res.headers);
    if (!res.ok) {
      const detail = `HTTP ${res.status}`;
      console.warn(`    ${detail} on ${ORIGIN}→${dest} ${start}→${end} (${direct ? 'direct' : 'any'})`);
      return { fare: null, outcome: 'http_error', detail };
    }
    let body;
    try { body = await res.json(); }
    catch (e) {
      const detail = `unparseable 200: ${e.message}`;
      console.warn(`    ${detail} on ${ORIGIN}→${dest}`);
      return { fare: null, outcome: 'http_error', detail };
    }
    if (!body.success) {
      // 2xx but the API refused the request (bad param, throttle, …). Diagnostically an error, so we
      // log it as http_error with the reason rather than a silent 'empty'.
      const detail = `success=false${body.error ? `: ${body.error}` : ''}`;
      console.warn(`    ${detail} on ${ORIGIN}→${dest}`);
      return { fare: null, outcome: 'http_error', detail };
    }
    if (!Array.isArray(body.data)) return { fare: null, outcome: 'empty', detail: '' };
    // Keep ONLY offers on the EXACT window dates, price>0; take the cheapest.
    let best = null;
    for (const x of body.data) {
      const dep = typeof x.departure_at === 'string' ? x.departure_at.slice(0, 10) : null;
      const ret = typeof x.return_at === 'string' ? x.return_at.slice(0, 10) : null;
      const price = typeof x.price === 'number' ? Math.round(x.price) : NaN;
      if (dep !== start || ret !== end || !(price > 0)) continue;
      if (!best || price < best.price) {
        best = { price, transfers: Number.isFinite(x.transfers) ? Math.trunc(x.transfers) : 0, airline: typeof x.airline === 'string' ? x.airline : null };
      }
    }
    if (best) return { fare: best, outcome: null, detail: '' };
    return { fare: null, outcome: 'empty', detail: '' }; // 200 + success, nothing on these exact dates
  } catch (e) {
    const detail = e.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : e.message;
    console.warn(`    connection failed on ${ORIGIN}→${dest}: ${detail}`);
    return { fare: null, outcome: 'network_error', detail };
  } finally {
    clearTimeout(timer);
  }
}

// ── shared batched-upsert retry — used by BOTH the price and the miss log so they persist by the SAME
// logic (only the back-off list differs). Makes `delays.length + 1` attempts: try, and on failure wait
// delays[i] before the next try, throwing only after the final attempt. Returns the row count on
// success. Prices pass [1000, 2000] — 3 attempts, 1 s / 2 s — the pre-existing behaviour, UNCHANGED.
const WP_CONFLICT = 'origin,dest,flight_type,departure_at,return_at';
async function upsertWithRetry(table, rows, delays) {
  const maxAttempts = delays.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { error } = await supabase.from(table).upsert(rows, { onConflict: WP_CONFLICT });
    if (!error) return rows.length;
    console.warn(`    ${table} upsert attempt ${attempt}/${maxAttempts} failed: ${error.code || ''} ${error.message}`);
    if (attempt === maxAttempts) throw new Error(`${table} upsert failed after ${maxAttempts} attempts: ${error.message}`);
    await sleep(delays[attempt - 1]);
  }
}

// ── window_prices buffer — flushed per destination (end of the dests loop) and whenever the buffer
// fills, so a crash loses at most the current destination's in-flight buffer, not the whole airport ─
const BATCH = 25;
let buffer = [];
let written = 0;
async function flush() {
  if (!buffer.length) return;
  const rows = buffer; buffer = [];
  written += await upsertWithRetry('window_prices', rows, [1000, 2000]);
}

// ── window_price_misses buffer — probes that stored NO fare. Same key, same batching as prices. The
// last outcome per key wins (upsert), so a re-probe overwrites rather than piling up. Longer back-off
// (2 s / 5 s / 15 s) than prices: this log is diagnostic, not on the app's read path.
const MISS_BATCH = 25;
let missBuffer = [];
let missWritten = 0;
const missCounts = { empty: 0, http_error: 0, network_error: 0 };
async function flushMisses() {
  if (!missBuffer.length) return;
  const rows = missBuffer; missBuffer = [];
  missWritten += await upsertWithRetry('window_price_misses', rows, [2000, 5000, 15000]);
}

// ── stale-miss cleanup — when a real fare lands for a key, any miss row left by an EARLIER run must go
// or it keeps claiming "no fare". Deletes are batched by the same key; origin is constant (ORIGIN),
// each row pinned by dest+flight_type+dates via .or(). A delete failure only WARNS (never throws): the
// price is already safely written, and the mark is corrected on the next successful run.
let deleteBuffer = [];
async function flushFoundDeletes() {
  if (!deleteBuffer.length) return;
  const rows = deleteBuffer; deleteBuffer = [];
  const clauses = rows
    .map((r) => `and(dest.eq.${r.dest},flight_type.eq.${r.flight_type},departure_at.eq.${r.departure_at},return_at.eq.${r.return_at})`)
    .join(',');
  const delays = [2000, 5000, 15000];
  const maxAttempts = delays.length + 1;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const { error } = await supabase.from('window_price_misses').delete().eq('origin', ORIGIN).or(clauses);
    if (!error) return;
    console.warn(`    window_price_misses delete attempt ${attempt}/${maxAttempts} failed: ${error.code || ''} ${error.message}`);
    if (attempt === maxAttempts) { console.warn(`    giving up on stale-miss cleanup for ${rows.length} keys (prices already written)`); return; }
    await sleep(delays[attempt - 1]);
  }
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────
// Planning date for THIS run: PLAN_DATE env if given (the workflow pins ONE date for the whole
// matrix, so parts that cross midnight still plan the SAME window set), else today in Europe/Berlin.
// Resolved ONCE and used for BOTH the window set and every progress marker.
const planDate = (process.env.PLAN_DATE || '').trim() || berlinToday();
if (!/^\d{4}-\d{2}-\d{2}$/.test(planDate)) {
  console.error(`PLAN_DATE must be YYYY-MM-DD, got "${planDate}". Aborting.`);
  process.exit(1);
}
console.log(`Window price sweep — origin ${ORIGIN}, horizon ${HORIZON_MONTHS} months, plan date ${planDate}`);
console.log(`Supabase: ${SUPABASE_URL}`);

const regionRows = await loadAll('origin_regions', 'airport,calendar_subdivision_code', ['airport']);
const regions = [...new Set(regionRows.map((r) => r.calendar_subdivision_code).filter(Boolean))].sort();
if (!regionRows.some((r) => r.airport === ORIGIN)) {
  console.error(`ORIGIN "${ORIGIN}" is not a known home airport (origin_regions). Aborting.`);
  process.exit(1);
}
const holidays = await loadAll('public_holidays', 'country,subdivision_code,level,date',
  ['country', 'subdivision_code', 'date']);
const windows = computeAllWindows(holidays, regions, planDate);

// This origin's catalogue destinations, from the prices table (distinct dest for this origin).
const priceRows = await loadAll('prices', 'origin,dest,month', ['origin', 'dest', 'month'], (q) => q.eq('origin', ORIGIN));
const allDests = [...new Set(priceRows.map((r) => r.dest))].sort();

// ── History-narrowed destination list ────────────────────────────────────────────────────────
// Ask only the TOP_DESTS destinations that have historically produced fares for THIS origin, ranked
// by how many window_prices rows they already have. The find-count is NOT stored anywhere new:
// window_prices IS the history — one row per fare found — so we just count its rows per dest.
const TOP_DESTS = Number(process.env.TOP_DESTS) || 50;

// Periodic FULL catalogue pass so destinations that never produced a fare are re-checked and a newly
// opened route is discovered. Airlines add routes almost only at the two IATA season boundaries
// (late March / late October), plus the odd mid-season addition; a MONTHLY full pass catches any new
// route within ~4 weeks — well inside the 10-day…6-month booking horizon — while a full pass costs
// only today's behaviour, amortised over ~a month. Anchored to the plan date's day-of-month so ALL
// 20 origin-parts of one run (same PLAN_DATE) make the SAME choice, with NO run counter to store.
// Override: FULL_SWEEP=1 forces a full pass, FULL_SWEEP=0 forces the narrow list.
const FULL_SWEEP_DOM = Number(process.env.FULL_SWEEP_DOM) || 3;
const fullSweepEnv = (process.env.FULL_SWEEP || '').trim();
const isFullSweep = fullSweepEnv === '1' ? true
  : fullSweepEnv === '0' ? false
  : Number(planDate.slice(8, 10)) <= FULL_SWEEP_DOM;

// Find counts from history: rows per dest in window_prices for this origin. Paginated read ordered by
// the full PK (repo rule: every .range() pairs with .order() on a unique key).
const histRows = await loadAll('window_prices', 'origin,dest',
  ['origin', 'dest', 'flight_type', 'departure_at', 'return_at'], (q) => q.eq('origin', ORIGIN));
const findCount = new Map();
for (const r of histRows) findCount.set(r.dest, (findCount.get(r.dest) || 0) + 1);

// Top-N catalogue dests by find count (ties broken by IATA for a stable list). Dests with no history
// are left out of the narrow list but stay in `allDests` for the periodic full pass above.
const rankedDests = allDests
  .filter((d) => findCount.has(d))
  .sort((a, b) => (findCount.get(b) - findCount.get(a)) || (a < b ? -1 : 1))
  .slice(0, TOP_DESTS);

// What we will actually sweep. A full pass — or a first-ever run with no history to rank on — asks
// the whole catalogue; otherwise just the top-N.
const bootstrap = findCount.size === 0;
const selectedDests = (isFullSweep || bootstrap) ? allDests : rankedDests;
const sweepMode = isFullSweep ? 'FULL (periodic catalogue pass)'
  : bootstrap ? 'FULL (bootstrap — no history yet)'
  : `TOP-${TOP_DESTS} by history`;
console.log(`Selection [${sweepMode}]: catalogue ${allDests.length} → asking ${selectedDests.length}, filtered out ${allDests.length - selectedDests.length} (${findCount.size} dests ever produced a fare).`);

// Resume: skip (origin, dest) pairs already marked done for THIS plan_date, so the workflow's
// catch-up pass (and any part that hit the timeout) only collects the tail. Paginated read —
// window_price_progress can exceed 1000 rows (22 origins × ~139 dests) and PostgREST caps at 1000.
const doneRows = await loadAll('window_price_progress', 'origin,dest,plan_date',
  ['origin', 'dest', 'plan_date'], (q) => q.eq('origin', ORIGIN).eq('plan_date', planDate));
const doneDests = new Set(doneRows.map((r) => r.dest));
const dests = selectedDests.filter((d) => !doneDests.has(d));

const totalRequests = dests.length * windows.length * 2; // × two variants
console.log(`Destinations for ${ORIGIN}: ${selectedDests.length} selected · ${doneDests.size} already collected (skipped) · ${dests.length} to do · plan ${planDate}`);
console.log(`Windows: ${windows.length} (holiday ${windows.filter((w) => w.kind === 'holiday').length}, weekend ${windows.filter((w) => w.kind === 'weekend').length}, weekend_around ${windows.filter((w) => w.kind === 'weekend_around').length}) · requests: ${totalRequests} (both variants) · pace ${intervalMs}ms ≈ ${Math.round(totalRequests * intervalMs / 60000)} min`);
if (!windows.length) { console.log('Nothing to collect — no windows in the horizon. Done.'); process.exit(0); }
if (!dests.length) {
  const why = selectedDests.length ? `all ${selectedDests.length} selected destinations already collected for plan ${planDate}` : 'no catalogue destinations for this origin';
  console.log(`Nothing to do for ${ORIGIN} — ${why}. Done.`);
  process.exit(0);
}

let made = 0;
for (let di = 0; di < dests.length; di += 1) {
  const dest = dests[di];
  quotaHeader(`${ORIGIN}→${dest} (${di + 1}/${dests.length})`); // §log header carrying remaining quota
  for (const w of windows) {
    for (const direct of [true, false]) {
      const flightType = direct ? 'direct' : 'any';
      const { fare, outcome, detail } = await fetchWindowFare(dest, w.start, w.end, direct);
      made += 1;
      if (fare) {
        buffer.push({
          origin: ORIGIN, dest, flight_type: flightType,
          departure_at: w.start, return_at: w.end, nights: w.nights,
          window_kind: w.kind, // 'weekend' | 'weekend_around' | 'holiday' — the window that produced this fare
          price: fare.price, transfers: fare.transfers, airline: fare.airline,
          updated_at: new Date().toISOString(),
        });
        // A real fare supersedes any earlier "no fare" mark for this EXACT key — drop it from the miss log.
        deleteBuffer.push({ dest, flight_type: flightType, departure_at: w.start, return_at: w.end });
        if (buffer.length >= BATCH) await flush(); // commit early so a crash cannot lose it
        if (deleteBuffer.length >= BATCH) await flushFoundDeletes();
      } else {
        // No storable price → record WHY, WITHOUT touching window_prices, so a previously collected
        // fare is NEVER overwritten by an empty/error answer (the table's core rule).
        missCounts[outcome] += 1;
        missBuffer.push({
          origin: ORIGIN, dest, flight_type: flightType,
          departure_at: w.start, return_at: w.end,
          window_kind: w.kind, outcome, detail: detail || '',
          checked_at: new Date().toISOString(),
        });
        if (missBuffer.length >= MISS_BATCH) await flushMisses();
      }
      await sleep(intervalMs); // pace at 80% of allowed
    }
  }

  // Destination fully swept: flush fares, misses and stale-miss deletes FIRST, then record progress.
  // flush()/flushMisses() throw on a hard failure, which skips the marker below — so a re-run
  // re-collects this destination rather than trusting a progress row with no data behind it.
  await flush();
  await flushMisses();
  await flushFoundDeletes();
  const { error: progErr } = await supabase
    .from('window_price_progress')
    .upsert({ origin: ORIGIN, dest, plan_date: planDate, done_at: new Date().toISOString() },
      { onConflict: 'origin,dest,plan_date' });
  if (progErr) console.warn(`    progress upsert failed for ${ORIGIN}→${dest}: ${progErr.code || ''} ${progErr.message}`);
}
await flush();
await flushMisses();
await flushFoundDeletes();
console.log(`Done. origin ${ORIGIN}: ${made} requests made, ${written} window fares written, ${missWritten} misses logged (empty ${missCounts.empty}, http_error ${missCounts.http_error}, network_error ${missCounts.network_error}). Final quota remaining ${quota.remaining ?? '—'}/${quota.limit ?? '—'}.`);
