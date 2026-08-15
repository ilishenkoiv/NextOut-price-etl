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
  const add = (w) => {
    if (w.start < minStart || w.start > maxStart) return;
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

// ── one exact-date query, one variant. Returns the cheapest matching fare or null (NEVER writes) ──
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
    if (!res.ok) { console.warn(`    HTTP ${res.status} on ${ORIGIN}→${dest} ${start}→${end} (${direct ? 'direct' : 'any'})`); return null; }
    let body; try { body = await res.json(); } catch { console.warn(`    unparseable 200 on ${ORIGIN}→${dest}`); return null; }
    if (!body.success || !Array.isArray(body.data)) return null;
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
    return best; // null = no fare on these exact dates → nothing to write (keep any prior row)
  } catch (e) {
    console.warn(`    connection failed on ${ORIGIN}→${dest}: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ── batched upsert — flushed per destination (end of the dests loop) and whenever the buffer fills,
// so a crash loses at most the current destination's in-flight buffer, not the whole airport ──────
const BATCH = 25;
let buffer = [];
let written = 0;
async function flush() {
  if (!buffer.length) return;
  const rows = buffer; buffer = [];
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const { error } = await supabase.from('window_prices').upsert(rows, { onConflict: 'origin,dest,flight_type,departure_at,return_at' });
    if (!error) { written += rows.length; return; }
    console.warn(`    upsert attempt ${attempt} failed: ${error.code || ''} ${error.message}`);
    if (attempt === 3) throw new Error(`window_prices upsert failed after 3 attempts: ${error.message}`);
    await sleep(1000 * attempt);
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
// window_price_progress can exceed 1000 rows (20 origins × ~132 dests) and PostgREST caps at 1000.
const doneRows = await loadAll('window_price_progress', 'origin,dest,plan_date',
  ['origin', 'dest', 'plan_date'], (q) => q.eq('origin', ORIGIN).eq('plan_date', planDate));
const doneDests = new Set(doneRows.map((r) => r.dest));
const dests = selectedDests.filter((d) => !doneDests.has(d));

const totalRequests = dests.length * windows.length * 2; // × two variants
console.log(`Destinations for ${ORIGIN}: ${selectedDests.length} selected · ${doneDests.size} already collected (skipped) · ${dests.length} to do · plan ${planDate}`);
console.log(`Windows: ${windows.length} (holiday ${windows.filter((w) => w.kind === 'holiday').length}, weekend ${windows.filter((w) => w.kind === 'weekend').length}) · requests: ${totalRequests} (both variants) · pace ${intervalMs}ms ≈ ${Math.round(totalRequests * intervalMs / 60000)} min`);
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
      const fare = await fetchWindowFare(dest, w.start, w.end, direct);
      made += 1;
      if (fare) {
        buffer.push({
          origin: ORIGIN, dest, flight_type: direct ? 'direct' : 'any',
          departure_at: w.start, return_at: w.end, nights: w.nights,
          price: fare.price, transfers: fare.transfers, airline: fare.airline,
          updated_at: new Date().toISOString(),
        });
        if (buffer.length >= BATCH) await flush(); // commit early so a crash cannot lose it
      }
      await sleep(intervalMs); // pace at 80% of allowed
    }
  }

  // Destination fully swept: flush its fares FIRST, then record progress. flush() throws on a hard
  // failure, which skips the marker below — so a re-run re-collects this destination rather than
  // trusting a progress row with no prices behind it.
  await flush();
  const { error: progErr } = await supabase
    .from('window_price_progress')
    .upsert({ origin: ORIGIN, dest, plan_date: planDate, done_at: new Date().toISOString() },
      { onConflict: 'origin,dest,plan_date' });
  if (progErr) console.warn(`    progress upsert failed for ${ORIGIN}→${dest}: ${progErr.code || ''} ${progErr.message}`);
}
await flush();
console.log(`Done. origin ${ORIGIN}: ${made} requests made, ${written} window fares written. Final quota remaining ${quota.remaining ?? '—'}/${quota.limit ?? '—'}.`);
