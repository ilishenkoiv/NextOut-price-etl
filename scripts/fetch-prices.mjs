// scripts/fetch-prices.mjs — NextOut Price ETL (standalone collector).
//
// Collects real Travelpayouts cache flight data and writes it to Supabase. Runs daily in
// GitHub Actions; can be run locally too. This is the ETL half of NextOut — it contains NO
// product logic (no ranking, no scoring, no UI), only the collection pipeline.
//
// THREE tables are filled from the SAME API responses:
//   • prices — one row per route-month = the cheapest price (the app reads this today).
//   • offers — every individual offer WHOLE (departure_at/return_at/nights/price/transfers/
//     airline). The v3 endpoint returns up to 30 dated offers per route-month; the old code
//     kept only Math.min and threw the rest away — losing which DAYS are cheap and mixing a
//     2-night fare into a 7-night Total. offers is a per-run SNAPSHOT: upsert on PK, then
//     stale rows (older than the run) are pruned, so it reflects current state, not a log.
//   • price_history — an APPEND-ONLY log of price CHANGES (never overwritten). prices upserts
//     on (origin,dest,month) so each run clobbers the previous value; without a log we lose
//     the time series needed for "cheaper than this month's average" and analytics. We insert
//     a row ONLY when direct/any_stops differ from what prices currently holds (or a route is
//     new) — a full snapshot each run would hit Supabase's storage cap in ~4 months; recording
//     only the ~10-20% that change per run lasts ~2 years.
//
//   PowerShell:  $env:TP_TOKEN="..."; $env:SUPABASE_SERVICE_KEY="..."; node scripts/fetch-prices.mjs
//   bash:        TP_TOKEN=... SUPABASE_SERVICE_KEY=... node scripts/fetch-prices.mjs
//
// Secrets come from env ONLY — never hardcode or commit them:
//   TP_TOKEN             — Travelpayouts API token (required).
//   SUPABASE_SERVICE_KEY — Supabase service-role key, writes past RLS (required, SECRET).
//   SUPABASE_URL         — project URL (public, NOT a secret; default below).
//
// One request per route-month, chosen by distance:
//   stops === 0 (near)      → query direct=true  → prices.direct
//   stops === 1 (long-haul) → query direct=false → prices.any_stops
//
// Hotel price segments (`hotels_segments`) are NOT collected here: they are maintained
// as static curated data in Supabase and refreshed manually. The former Hotellook API
// integration (`hotels`/`hotels_segments` collection) was removed — the upstream
// endpoints (engine.hotellook.com) were discontinued and return 404 on everything.

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { gzipSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HUB_AIRPORTS, LOWCOST_AIRPORTS, ORIGINS_ALL } from '../src/data/origins.js';
import { DESTINATIONS } from '../src/data/destinations.js';
import { ORIGIN_COORDS, DEST_COORDS } from '../src/data/coords.js';

// ── Config / secrets (env only) ──────────────────────────────────────────────
const TP_TOKEN = process.env.TP_TOKEN;
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xpalogebawoljlafsafs.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!TP_TOKEN || !SUPABASE_SERVICE_KEY) {
  console.error('ERROR: missing required env vars — nothing was requested.');
  if (!TP_TOKEN) console.error('  • TP_TOKEN (Travelpayouts API token) is not set.');
  if (!SUPABASE_SERVICE_KEY) console.error('  • SUPABASE_SERVICE_KEY (Supabase service-role key) is not set.');
  console.error('  PowerShell:  $env:TP_TOKEN="..."; $env:SUPABASE_SERVICE_KEY="..."; node scripts/fetch-prices.mjs');
  console.error('  bash:        TP_TOKEN=... SUPABASE_SERVICE_KEY=... node scripts/fetch-prices.mjs');
  process.exit(1);
}

// Decode the JWT payload's `role` claim (NOT the secret) so we can confirm at runtime
// that a service_role key is used — an anon key would hit "permission denied for table".
function keyRole(key) {
  try {
    const seg = key.split('.')[1];
    if (!seg) return '(opaque non-JWT key)';
    const payload = JSON.parse(Buffer.from(seg, 'base64url').toString('utf8'));
    return payload.role || '(no role claim)';
  } catch {
    return '(unreadable)';
  }
}
const SERVICE_KEY_ROLE = keyRole(SUPABASE_SERVICE_KEY);

// The service_role key is sent as both `apikey` and `Authorization: Bearer`, bypassing
// RLS. We ONLY write via REST (PostgREST upsert) — never realtime. supabase-js still
// builds a RealtimeClient at createClient, which throws "native WebSocket not found" on
// Node < 22; passing the `ws` package as the realtime transport satisfies that on ANY
// Node version (the socket is never actually connected).
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket },
});
if (SERVICE_KEY_ROLE !== 'service_role') {
  console.warn(`WARNING: SUPABASE_SERVICE_KEY role = "${SERVICE_KEY_ROLE}" (expected "service_role") — writes will likely be denied.`);
}

// ── Route planning from the local data files ─────────────────────────────────
// stops per destination (0 = near/direct, 1 = long-haul/one-stop).
const STOPS = {};
const DEST_IATAS = [];
for (const d of DESTINATIONS) {
  if (STOPS[d.iata] === undefined) { STOPS[d.iata] = d.stops; DEST_IATAS.push(d.iata); }
}

// Targets per origin: EVERY destination, for EVERY origin (hubs and low-cost bases alike).
// The former narrow per-origin map for low-cost bases under-collected the cheapest fares;
// we now query the whole network and let the API return null where there's no route.
// Self-excluded (d !== origin) so an airport is never queried against itself.
function targetsFor(origin) {
  return DEST_IATAS.filter((d) => d !== origin && STOPS[d] !== undefined);
}

// ── COMBO selection: cheap pool + min-nights-by-distance targets ─────────────────
// From the FULL month response (limit=500) we keep, per route-month+flight_type:
//   (a) the N cheapest offers of ANY length  → in_cheap_pool = true
//   (b) the cheapest offer within ±1 night of each TARGET duration → target_nights = target
// Targets depend on distance (haversine origin→dest, from coords.js) AND stops (curated):
//   near <1500km:            3/5/7/10/14
//   mid  1500–4000km:        5/7/10/14
//   far  >4000km & stops=0:  5/7/10/14   (direct long-haul, e.g. Dubai)
//   far  >4000km & stops=1:  7/10/14     (island/Asia/Americas via a stop)
// One offer may carry BOTH tags (never duplicated). Where a target has no offer in ±1, no row
// is created — the app honestly shows a seed "estimate" there (selectFlightOffer needs nights±2).
const CHEAP_N = 10;
function haversineKm(a, b) {
  const R = 6371, t = (x) => x * Math.PI / 180;
  const dLat = t(b[0] - a[0]), dLon = t(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(t(a[0])) * Math.cos(t(b[0])) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
function targetSet(origin, dest) {
  const oc = ORIGIN_COORDS[origin], dc = DEST_COORDS[dest];
  if (!oc || !dc) return [5, 7, 10, 14]; // safe default if a coord is ever missing
  const km = haversineKm(oc, dc);
  const stops = STOPS[dest] ?? 1;
  if (km < 1500) return [3, 5, 7, 10, 14];
  if (km <= 4000) return [5, 7, 10, 14];
  return stops === 0 ? [5, 7, 10, 14] : [7, 10, 14];
}
function selectCombo(offers, origin, dest) {
  const usable = offers.filter((o) => o.price > 0 && o.nights != null && o.nights >= 1);
  if (!usable.length) return [];
  const byPrice = [...usable].sort((a, b) => a.price - b.price); // ascending → first match = cheapest
  const chosen = new Map(); // `${departure_at}|${return_at}` → tagged offer
  const take = (o, patch) => {
    const k = `${o.departure_at}|${o.return_at}`;
    const cur = chosen.get(k) || { ...o, in_cheap_pool: false, target_nights: null };
    if (patch.cheap) cur.in_cheap_pool = true;
    if (patch.target != null && cur.target_nights == null) cur.target_nights = patch.target;
    chosen.set(k, cur);
  };
  for (const o of byPrice.slice(0, CHEAP_N)) take(o, { cheap: true });            // (a) cheap pool
  for (const t of targetSet(origin, dest)) {                                      // (b) per target
    const best = byPrice.find((o) => Math.abs(o.nights - t) <= 1);
    if (best) take(best, { target: t });
  }
  return [...chosen.values()];
}

// ≥1100ms between ALL TP calls keeps us under the 60/min limit with margin. Overridable
// via TP_PAUSE_MS for CI/re-runs; do NOT drop below ~1100 against the live API.
const PAUSE_MS = Number(process.env.TP_PAUSE_MS) || 1100;
const TIMEOUT_MS = 15000;
const BATCH = 500; // rows per Supabase upsert — batched, not row-by-row
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');

// Month window, parameterized so a long horizon can be split across sequential CI jobs
// without either exceeding the 6-hour job limit or the 60 req/min API limit.
//   MONTH_START — 1-based offset from the current month (default 1). START=1 → the NEXT
//                 full month; the current, partially-elapsed month is never collected
//                 (matches the app's horizon — lib/prices.ts horizonMonths).
//   MONTH_COUNT — how many consecutive months to collect (default 6).
// Examples:  MONTH_START=1 MONTH_COUNT=6 → the near 6 months (default).
//            MONTH_START=7 MONTH_COUNT=6 → the far months 7–12.
const MONTH_START = Number(process.env.MONTH_START) || 1;
const MONTH_COUNT = Number(process.env.MONTH_COUNT) || 6;
// Snapshot scope label = which month-slice THIS job collected (near=1–6, far=7–12).
const SCOPE = MONTH_START <= 1 ? 'near'
  : MONTH_START === 7 ? 'far'
  : `m${MONTH_START}-${MONTH_START + MONTH_COUNT - 1}`;
const now = new Date();
const MONTHS = [];
for (let i = 0; i < MONTH_COUNT; i += 1) {
  // +MONTH_START skips the current partially-elapsed month; +i walks the window.
  const d = new Date(now.getFullYear(), now.getMonth() + MONTH_START + i, 1);
  MONTHS.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
}

// Fetch JSON with a timeout. Never throws — logs and returns null on any failure.
async function getJson(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      console.warn(`    HTTP ${res.status} on ${url.split('?')[0]}`);
      return null;
    }
    return await res.json();
  } catch (e) {
    console.warn(`    request failed: ${e.message}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ISO datetime → date-only 'YYYY-MM-DD', or null if unusable. STRING SLICE, never
// new Date(): the API returns a local departure time ('2026-09-17T10:25:00+02:00'); a
// Date round-trip would shift the calendar day across the timezone. Slicing keeps the
// exact local date the traveler flies.
function toDateOnly(s) {
  if (typeof s !== 'string' || s.length < 10) return null;
  const d = s.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
}

// Whole nights between two date-only strings, or null when there is no return date.
// Both dates are anchored at UTC midnight so a DST transition between them can't add or
// drop an hour and skew the day count. Negative (malformed) → null.
function nightsBetween(dep, ret) {
  if (!dep || !ret) return null;
  const a = Date.parse(`${dep}T00:00:00Z`);
  const b = Date.parse(`${ret}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  const n = Math.round((b - a) / 86400000);
  return n >= 0 ? n : null;
}

// Fetch one route-month from the v3 cache and return BOTH:
//   • min   — the cheapest price>0 (unchanged legacy behavior → the `prices` table).
//   • offers — EVERY individual offer parsed & validated → the `offers` table. Each API
//     item carries its own departure_at/return_at/price/transfers/airline; the old code
//     did Math.min and discarded all of that (losing which DAYS are cheap, and mixing
//     short-trip prices into a 7-night Total). We now keep every offer whole.
// `ok` is true whenever the API responded successfully (even with 0 offers) — the caller
// uses it to decide whether it may prune stale offers for this route-month.
// direct=true → non-stop only (flight_type 'direct'); direct=false → any stops ('any').
async function fetchFlightMonth(origin, dest, ym, direct) {
  const url =
    `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?origin=${origin}` +
    `&destination=${dest}&departure_at=${ym}&return_at=${ym}&direct=${direct}` +
    // limit RAISED 30→500: the cheapest 30 were all short trips (1–4n) → the long durations
    // (10/14n) drowned. 500 returns EVERY duration for combo selection. Still ONE request
    // (TP rate-limits per REQUEST, not per row) — no extra API calls.
    `&currency=eur&limit=500&token=${TP_TOKEN}`;
  const r = await getJson(url);
  if (!r || !r.success || !Array.isArray(r.data)) {
    return { ok: false, min: null, offers: [] };
  }

  // `prices` table: min over any price>0 — IDENTICAL to the previous implementation, so
  // the app-facing `prices` table is byte-for-byte unchanged (validated separately below).
  const prices = r.data.map((x) => x.price).filter((p) => typeof p === 'number' && p > 0);
  const min = prices.length ? Math.round(Math.min(...prices)) : null;

  // `offers` table: parse & validate each item. month is the REQUESTED ym (1d) — not the
  // offer's departure month, which can differ by a day at a month boundary.
  const flightType = direct ? 'direct' : 'any';
  const nowIso = new Date().toISOString();
  const offers = [];
  for (const x of r.data) {
    const departure_at = toDateOnly(x.departure_at);
    const price = typeof x.price === 'number' ? Math.round(x.price) : NaN;
    if (!departure_at || !(price > 0)) continue; // validation (1e): needs a dep date & price>0
    const return_at = toDateOnly(x.return_at); // null for one-way
    offers.push({
      origin,
      dest,
      month: ym,
      flight_type: flightType,
      departure_at,
      return_at,
      nights: nightsBetween(departure_at, return_at),
      price,
      transfers: Number.isFinite(x.transfers) ? Math.trunc(x.transfers) : 0,
      airline: typeof x.airline === 'string' ? x.airline : null,
      updated_at: nowIso,
    });
  }
  return { ok: true, min, offers };
}

// Load the CURRENT price for every route-month from `prices` in ONE paginated scan, keyed by
// `origin|dest|month`. This is the baseline the run compares against so price_history only logs
// CHANGES. PostgREST silently caps a .select() at 1000 rows (we have ~7000+) — we page with
// .range() and a STABLE .order(), because unordered pages can repeat or skip rows across the cap.
async function loadExistingPrices() {
  const map = new Map();
  const PAGE = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('prices')
      .select('origin,dest,month,direct,any_stops')
      .order('origin', { ascending: true })
      .order('dest', { ascending: true })
      .order('month', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) {
      // A read failure here would make EVERY route look "changed" and flood price_history.
      // Abort loudly instead of silently logging a spurious full snapshot.
      throw new Error(`could not load existing prices (baseline): ${error.message}`);
    }
    if (!data || data.length === 0) break;
    for (const r of data) map.set(`${r.origin}|${r.dest}|${r.month}`, { direct: r.direct, any_stops: r.any_stops });
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return map;
}

// ── Price snapshot: append-only gzip-CSV history for future analysis ──────────
// PURELY ADDITIVE. Runs AFTER all Supabase writes; never changes what/how we collect
// or what we write to Supabase. Any failure is logged and swallowed so a snapshot
// problem can NEVER fail the ETL. Path: snapshots/YYYY/MM/YYYY-MM-DD_HHMM_<scope>.csv.gz
// (HHMM = Europe/Berlin, matching the ETL schedule). Columns are explicit + stable.
function berlinStampParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return { y: g('year'), mo: g('month'), da: g('day'), hh: g('hour'), mi: g('minute') };
}
function writeSnapshot(rows, scope) {
  try {
    const { y, mo, da, hh, mi } = berlinStampParts(new Date());
    const dir = join('snapshots', y, mo);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${y}-${mo}-${da}_${hh}${mi}_${scope}.csv.gz`);
    const esc = (v) => (v == null ? '' : String(v));
    let csv = 'origin,dest,depart_month,price_direct,price_any,currency,fetched_at,scope\n';
    for (const r of rows) {
      csv += [r.origin, r.dest, r.month, esc(r.direct), esc(r.any), 'EUR', r.fetched_at, scope].join(',') + '\n';
    }
    const gz = gzipSync(Buffer.from(csv, 'utf8'), { level: 9 });
    writeFileSync(file, gz);
    console.log(`Snapshot: ${file}  (${rows.length} rows, ${(gz.length / 1024).toFixed(1)} KB gz)`);
  } catch (e) {
    console.warn(`⚠ snapshot write failed (non-fatal, ETL unaffected): ${e.message}`);
  }
}

async function main() {
  // Plan the run so we can print totals and a live ETA.
  const plan = ORIGINS_ALL.map((o) => ({ origin: o, targets: targetsFor(o) }));
  const routeTotal = plan.reduce((s, p) => s + p.targets.length, 0);
  const totalRequests = routeTotal * MONTHS.length; // ONE request per route-month

  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Supabase key role: ${SERVICE_KEY_ROLE}`);
  console.log(`Origins (${ORIGINS_ALL.length}, all query the full ${DEST_IATAS.length}-destination network): ${ORIGINS_ALL.join(', ')}`);
  console.log(`  hubs (${HUB_AIRPORTS.length}): ${HUB_AIRPORTS.join(', ')}`);
  console.log(`  low-cost bases (${LOWCOST_AIRPORTS.length}): ${LOWCOST_AIRPORTS.join(', ')}`);
  console.log(`Flight months (${MONTHS.length}): ${MONTHS[0]} … ${MONTHS[MONTHS.length - 1]}  (MONTH_START=${MONTH_START}, MONTH_COUNT=${MONTH_COUNT})`);
  console.log(`Route-pairs: ${routeTotal}  ·  Flight requests: ${totalRequests} (1 per route-month)`);
  console.log(`At ≥${PAUSE_MS}ms/request ≈ ${Math.round(totalRequests * PAUSE_MS / 60000)} min\n`);

  // Start-of-run timestamp. Rows written this run get updated_at >= this; stale-offer
  // pruning deletes only rows OLDER than it, so a fresh row is never removed.
  const RUN_START_ISO = new Date().toISOString();

  // Baseline: the current price of every route-month, loaded ONCE (paginated) before the run.
  // price_history rows are written only where this run's price differs from this snapshot.
  const existingPrices = await loadExistingPrices();
  console.log(`Loaded ${existingPrices.size} existing price rows (baseline for change detection)\n`);

  // Supabase write buffer + counters. We flush in BATCH-sized upserts, and flush
  // periodically during the (multi-hour) run so partial progress is persisted.
  const priceBuf = [];
  const snapshotRows = []; // TEE of this run's collected price rows → gzip-CSV history file
  let pricesWritten = 0;
  let priceWriteErrors = 0;

  async function flushPrices(force = false) {
    while (priceBuf.length >= BATCH || (force && priceBuf.length > 0)) {
      const rows = priceBuf.splice(0, BATCH);
      try {
        const { error } = await supabase.from('prices').upsert(rows, { onConflict: 'origin,dest,month' });
        if (error) { console.warn(`    ⚠ prices upsert error (${rows.length} rows): ${error.message}`); priceWriteErrors += rows.length; }
        else pricesWritten += rows.length;
      } catch (e) {
        console.warn(`    ⚠ prices upsert threw (${rows.length} rows): ${e.message}`);
        priceWriteErrors += rows.length;
      }
    }
  }

  // ── price_history table: append-only log of price CHANGES (batched, insert only) ──
  // A row is pushed only when a route-month's price differs from the baseline (see the loop).
  // insert (not upsert): every row is a new observation; observed_at defaults to now() in the DB.
  const historyBuf = [];
  let historyWritten = 0;
  let historyWriteErrors = 0;
  let pricesChanged = 0;   // route-months whose price changed or are new-with-a-price (→ logged)
  let pricesUnchanged = 0; // route-months whose price matched the baseline (→ NOT logged)

  async function flushHistory(force = false) {
    while (historyBuf.length >= BATCH || (force && historyBuf.length > 0)) {
      const rows = historyBuf.splice(0, BATCH);
      try {
        const { error } = await supabase.from('price_history').insert(rows);
        if (error) { console.warn(`    ⚠ price_history insert error (${rows.length} rows): ${error.message}`); historyWriteErrors += rows.length; }
        else historyWritten += rows.length;
      } catch (e) {
        console.warn(`    ⚠ price_history insert threw (${rows.length} rows): ${e.message}`);
        historyWriteErrors += rows.length;
      }
    }
  }

  // ── offers table: every individual offer (departure/return dates preserved) ──────
  // Written in parallel with `prices` from the SAME API responses. offers is a SNAPSHOT
  // (upsert on PK, then stale rows pruned), not an accumulating log — its size is stable.
  const offerBuf = [];
  let offersWritten = 0;
  let offerWriteErrors = 0;
  let offersCollected = 0;    // valid offers parsed from the API (across all route-months)
  let okRouteMonths = 0;      // route-months where the API responded (for the avg metric)
  let offersDeleted = 0;      // stale rows pruned
  let offerDeleteErrors = 0;

  async function flushOffers(force = false) {
    while (offerBuf.length >= BATCH || (force && offerBuf.length > 0)) {
      const rows = offerBuf.splice(0, BATCH);
      try {
        const { error } = await supabase
          .from('offers')
          .upsert(rows, { onConflict: 'origin,dest,month,flight_type,departure_at,return_at' });
        if (error) { console.warn(`    ⚠ offers upsert error (${rows.length} rows): ${error.message}`); offerWriteErrors += rows.length; }
        else offersWritten += rows.length;
      } catch (e) {
        console.warn(`    ⚠ offers upsert threw (${rows.length} rows): ${e.message}`);
        offerWriteErrors += rows.length;
      }
    }
  }

  // Prune offers for one route (its successfully-fetched months only) that are OLDER than
  // this run — i.e. offers the API no longer returns. Scoped to `months` (via .in) so a
  // month whose request FAILED this run keeps its previous offers instead of being wiped.
  // .select() returns the deleted rows so we can count them.
  async function pruneStaleOffers(origin, dest, flightType, months) {
    try {
      const { data, error } = await supabase
        .from('offers')
        .delete()
        .eq('origin', origin)
        .eq('dest', dest)
        .eq('flight_type', flightType)
        .in('month', months)
        .lt('updated_at', RUN_START_ISO)
        .select('origin');
      if (error) { console.warn(`    ⚠ offers prune error ${origin}→${dest}: ${error.message}`); offerDeleteErrors += 1; }
      else offersDeleted += (data?.length ?? 0);
    } catch (e) {
      console.warn(`    ⚠ offers prune threw ${origin}→${dest}: ${e.message}`);
      offerDeleteErrors += 1;
    }
  }

  let withPrice = 0; // routes that got at least one price
  let noData = 0;    // routes with no price at all
  let reqDone = 0;
  let route = 0;
  const t0 = Date.now();
  const etaMin = () => Math.round((totalRequests - reqDone) * PAUSE_MS / 60000);

  for (const { origin, targets } of plan) {
    for (const dest of targets) {
      route += 1;
      const stops = STOPS[dest];
      const flightHasStop = stops === 1; // long-haul default: cheapest 1+ stop
      const flightType = flightHasStop ? 'any' : 'direct';
      const byMonth = {};
      const okMonths = []; // months the API answered → the only ones we may prune
      for (const ym of MONTHS) {
        // ONE request per route-month, chosen by distance: near = direct, far = any.
        const { ok, min, offers } = await fetchFlightMonth(origin, dest, ym, !flightHasStop);
        reqDone += 1;
        const pair = flightHasStop ? { direct: null, any: min } : { direct: min, any: null };
        byMonth[ym] = pair;
        // One prices row per route-month → upsert on PK (origin,dest,month). Unchanged.
        priceBuf.push({ origin, dest, month: ym, direct: pair.direct, any_stops: pair.any, updated_at: new Date().toISOString() });
        // Tee (observe only) the same values for the history snapshot — no effect on collection/write.
        snapshotRows.push({ origin, dest, month: ym, direct: pair.direct, any: pair.any, fetched_at: RUN_START_ISO });

        // price_history: log ONLY when this price differs from the baseline (or the route is new).
        // Compare each column against the loaded snapshot (null-normalized so null===null matches).
        // We DON'T log a change that has no price at all (both null) — a route that returned no
        // data, or a transient API failure clobbering prices to null, is noise, not a real
        // observation. Genuine prices (including a price appearing where there was none) are logged.
        const prev = existingPrices.get(`${origin}|${dest}|${ym}`);
        const hasPrice = pair.direct != null || pair.any != null;
        const changed = !prev
          || (prev.direct ?? null) !== (pair.direct ?? null)
          || (prev.any_stops ?? null) !== (pair.any ?? null);
        if (changed && hasPrice) {
          historyBuf.push({ origin, dest, month: ym, direct: pair.direct, any_stops: pair.any });
          pricesChanged += 1;
        } else if (!changed) {
          pricesUnchanged += 1;
        }
        // COMBO selection → the offers buffer (only when the API actually answered). From the
        // full ≤500 response we keep the cheap pool + one offer per distance-matrix target,
        // tagged (in_cheap_pool / target_nights). offersCollected counts what we STORE.
        if (ok) {
          okRouteMonths += 1;
          okMonths.push(ym);
          const combo = selectCombo(offers, origin, dest);
          for (const o of combo) offerBuf.push(o);
          offersCollected += combo.length;
        }
        await sleep(PAUSE_MS);
      }
      await flushPrices(false);
      await flushHistory(false);

      // Force-flush THIS route's offers so they are persisted BEFORE we prune stale ones.
      // Only prune when the write raised no error (else we'd delete old data without a
      // replacement) and only for months that actually responded.
      const offerErrBefore = offerWriteErrors;
      await flushOffers(true);
      if (okMonths.length && offerWriteErrors === offerErrBefore) {
        await pruneStaleOffers(origin, dest, flightType, okMonths);
      }

      const got = Object.values(byMonth).some((p) => p.direct != null || p.any != null);
      if (got) withPrice += 1; else noData += 1;
      const vals = Object.values(byMonth).map((p) => (flightHasStop ? p.any : p.direct)).filter((p) => p != null);
      const min = vals.length ? `€${Math.min(...vals)}` : '—';
      console.log(`[route ${route}/${routeTotal}] ${origin}→${dest} (${flightType}): ${min}   ~${etaMin()}m left`);
    }
  }
  await flushPrices(true);
  await flushHistory(true);
  await flushOffers(true); // safety net; per-route force-flushes normally drain it already

  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
  const avgOffers = okRouteMonths ? (offersCollected / okRouteMonths).toFixed(1) : '0';
  console.log('\n──────── summary ────────');
  console.log(`TP requests: ${totalRequests}`);
  console.log(`Origins: ${ORIGINS_ALL.length} (${HUB_AIRPORTS.length} hubs + ${LOWCOST_AIRPORTS.length} low-cost)`);
  console.log(`Destinations: ${DEST_IATAS.length}  ·  Route-pairs: ${routeTotal}  ·  Months: ${MONTHS.length}  ·  requests: ${totalRequests}`);
  console.log(`Routes with a price: ${withPrice}  ·  no data: ${noData}`);
  console.log(`Supabase prices: ${pricesWritten} rows written, ${priceWriteErrors} errors`);
  console.log(`Price changes: ${pricesChanged} changed/new  ·  ${pricesUnchanged} unchanged (baseline ${existingPrices.size})`);
  console.log(`Supabase price_history: ${historyWritten} rows written, ${historyWriteErrors} errors`);
  console.log(`Supabase offers: ${offersWritten} rows written, ${offerWriteErrors} errors`);
  console.log(`  offers collected: ${offersCollected}  ·  avg per route-month: ${avgOffers} (over ${okRouteMonths} answered route-months)`);
  console.log(`  stale offers pruned: ${offersDeleted}  ·  prune errors: ${offerDeleteErrors}`);
  console.log(`Elapsed: ${elapsedMin} min`);

  // Additive history step — AFTER every Supabase write. Non-blocking (see writeSnapshot).
  writeSnapshot(snapshotRows, SCOPE);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
