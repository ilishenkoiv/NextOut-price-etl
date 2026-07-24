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

// Fixed INTERVAL, not a fixed pause. We used to sleep 1100 ms AFTER each response, which
// makes the real spacing HTTP + 1100 — so the run's length was set by Travelpayouts' latency,
// not by us. Measured: 1196 ms average spacing (50.1 req/min, not the 54.5 the pause implied),
// and when TP slowed from 96 ms to 200–390 ms the same sweep grew from 315 to 355+ min and
// two runs were cancelled on timeout. Now we time the request and sleep only the remainder of
// TARGET_INTERVAL_MS, so a slower API costs nothing until it exceeds the interval outright.
// 1091 ms = 55 req/min against the 60/min ceiling. Overridable via TP_TARGET_INTERVAL_MS for
// CI/re-runs; do NOT drop below ~1091 against the live API.
const TARGET_INTERVAL_MS = Number(process.env.TP_TARGET_INTERVAL_MS) || 1091;
// 8s, down from 15s. Nothing useful ever arrived that late — TP answers in 96–390 ms, and the
// observed failures are 502/503 bursts, so a long ceiling only bought dead waiting time.
const TIMEOUT_MS = 8000;
const BATCH = 500; // rows per Supabase upsert — batched, not row-by-row
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');

// Month window, parameterized so a long horizon can be split across sequential CI jobs
// without either exceeding the 6-hour job limit or the 60 req/min API limit.
//   MONTH_START — 1-based offset from the current month (default 1). START=1 → the NEXT
//                 full month; the current, partially-elapsed month is never collected
//                 (matches the app's horizon — lib/prices.ts horizonMonths).
//   MONTH_COUNT — how many consecutive months to collect (default 6).
// CI splits the 12-month horizon into FOUR sequential 3-month jobs (see the workflow):
//   MONTH_START=1  MONTH_COUNT=3 → months 1–3
//   MONTH_START=4  MONTH_COUNT=3 → months 4–6
//   MONTH_START=7  MONTH_COUNT=3 → months 7–9
//   MONTH_START=10 MONTH_COUNT=3 → months 10–12
const MONTH_START = Number(process.env.MONTH_START) || 1;
const MONTH_COUNT = Number(process.env.MONTH_COUNT) || 6;
// Snapshot scope label = which month-slice THIS job collected. Uniform `mA-B` since the
// split went from 2 jobs to 4: the old `near`/`far` labels meant 1–6 and 7–12 and would now
// name a 3-month slice after a 6-month one. Older objects in the bucket keep their names.
const SCOPE = `m${MONTH_START}-${MONTH_START + MONTH_COUNT - 1}`;
const now = new Date();

// ── The run's day number: the single seed behind everything date-dependent here ───────────
// Days since the Unix epoch, in UTC. Deliberately NOT a day-of-year: 365 % 7 === 1, so
// Dec 31 and Jan 1 would fall in the same weekly slot and one slot would be skipped for a
// year. PLAN_DATE (YYYY-MM-DD) pins it, so a past run can be reproduced exactly.
// NOTE: the four CI jobs each compute this themselves, so a sweep that starts before
// midnight UTC and ends after it uses two consecutive day numbers — a different route order
// and a different dead-pair slice for the later months. Harmless; both are valid plans.
const PLAN_DATE = process.env.PLAN_DATE ? new Date(`${process.env.PLAN_DATE}T00:00:00Z`) : now;
if (Number.isNaN(PLAN_DATE.getTime())) {
  console.error(`ERROR: PLAN_DATE="${process.env.PLAN_DATE}" is not a valid YYYY-MM-DD date.`);
  process.exit(1);
}
const PLAN_DAY = Math.floor(
  Date.UTC(PLAN_DATE.getUTCFullYear(), PLAN_DATE.getUTCMonth(), PLAN_DATE.getUTCDate()) / 86400000,
);

// mulberry32 — a tiny deterministic PRNG. Same seed, same sequence, so the whole plan is
// reproducible from the date alone; Math.random() would make a cancelled run impossible to
// replay and impossible to reason about.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Fisher-Yates with a seeded PRNG.
function shuffledBySeed(items, seed) {
  const a = [...items];
  const rnd = mulberry32(seed);
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

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
  // Transport failure — getJson already logged the status or the exception.
  if (!r) return { ok: false, min: null, offers: [], reason: 'request' };
  // An HONEST 200 that still carries nothing usable: success:false, or `data` that is not an
  // array. This branch used to return ok:false SILENTLY, which made it indistinguishable from
  // "no flights on this route" in both the log and the database — the same class of invisible
  // loss as the null-clobbering. Log it and count it separately.
  if (!r.success || !Array.isArray(r.data)) {
    const shape = Array.isArray(r.data) ? 'array' : `${typeof r.data}${r.data === undefined ? ' (absent)' : ''}`;
    const why = typeof r.error === 'string' ? ` error="${r.error}"` : '';
    console.warn(`    unusable 200 ${origin}→${dest} ${ym} (${direct ? 'direct' : 'any'}): success=${r.success}, data=${shape}${why}`);
    return { ok: false, min: null, offers: [], reason: 'body' };
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

// ── Price snapshot: gzip-CSV history uploaded to Supabase Storage ─────────────
// PURELY ADDITIVE. Runs AFTER all Supabase TABLE writes; never changes what/how we collect
// or what we write to prices/offers/price_history. Any failure is logged and swallowed so a
// snapshot problem can NEVER fail the ETL — same contract as the prices/offers write errors.
//
// Snapshots used to be written to disk and pushed back to the repo by a workflow step; they
// now go to the PRIVATE `price-snapshots` bucket, written with the SAME service_role key as
// the tables (no new secret). The in-bucket key is unchanged from the git era:
//   snapshots/YYYY/MM/YYYY-MM-DD_HHMM_<scope>.csv.gz   (HHMM = Europe/Berlin, matching the
// ETL schedule). upsert:true so re-running a job within the same minute replaces the object
// instead of failing. Columns are explicit + stable.
const SNAPSHOT_BUCKET = 'price-snapshots';
const SNAPSHOT_MAX_BYTES = 50 * 1024 * 1024; // Supabase free tier: 50 MB per object.
function berlinStampParts(d = new Date()) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(d);
  const g = (t) => p.find((x) => x.type === t).value;
  return { y: g('year'), mo: g('month'), da: g('day'), hh: g('hour'), mi: g('minute') };
}
async function uploadSnapshot(rows, scope) {
  let gz = null;
  try {
    const { y, mo, da, hh, mi } = berlinStampParts(new Date());
    // Storage object keys are ALWAYS '/'-separated — built as a plain string, never
    // path.join(), which on Windows emits backslashes and would create a differently-named
    // object for a local run than for CI.
    const key = `snapshots/${y}/${mo}/${y}-${mo}-${da}_${hh}${mi}_${scope}.csv.gz`;
    const esc = (v) => (v == null ? '' : String(v));
    let csv = 'origin,dest,depart_month,price_direct,price_any,currency,fetched_at,scope\n';
    for (const r of rows) {
      csv += [r.origin, r.dest, r.month, esc(r.direct), esc(r.any), 'EUR', r.fetched_at, scope].join(',') + '\n';
    }
    gz = gzipSync(Buffer.from(csv, 'utf8'), { level: 9 });
    const kb = (gz.length / 1024).toFixed(1);
    // A full 12-month sweep gzips to ~60 KB, so 50 MB is a tripwire rather than a real
    // bound. Warn loudly but still attempt the upload, so the server's own answer lands in
    // the log instead of our guess about what it would have said.
    if (gz.length > SNAPSHOT_MAX_BYTES) {
      console.warn(
        `⚠ snapshot is ${(gz.length / 1048576).toFixed(1)} MB — over the ` +
        `${SNAPSHOT_MAX_BYTES / 1048576} MB per-object cap of the Supabase free tier; ` +
        'the upload will probably be rejected.',
      );
    }
    const { error } = await supabase.storage
      .from(SNAPSHOT_BUCKET)
      .upload(key, gz, { contentType: 'application/gzip', upsert: true });
    if (error) {
      console.warn(`⚠ snapshot upload failed (non-fatal, ETL unaffected): ${error.message}`);
      return { ok: false, key, kb, rows: rows.length, error: error.message };
    }
    return { ok: true, key, kb, rows: rows.length, error: null };
  } catch (e) {
    console.warn(`⚠ snapshot upload failed (non-fatal, ETL unaffected): ${e.message}`);
    return { ok: false, key: null, kb: gz ? (gz.length / 1024).toFixed(1) : null, rows: rows.length, error: e.message };
  }
}

async function main() {
  // Plan the run so we can print totals and a live ETA.
  //
  // ORDER IS SHUFFLED, deterministically, with the day number as the seed. The plan used to
  // be walked in catalog order, so anything that cut a run short — a timeout, a cancellation,
  // a 502 burst — always cost the SAME airports, the ones sitting in the tail (DRS, LEJ went
  // uncollected repeatedly). Shuffling spreads that damage over the whole network instead of
  // concentrating it, while the seed keeps the run replayable: same date, same order.
  const catalogRoutes = [];
  for (const origin of ORIGINS_ALL) {
    for (const dest of targetsFor(origin)) catalogRoutes.push({ origin, dest });
  }
  const routes = shuffledBySeed(catalogRoutes, PLAN_DAY);
  const routeTotal = routes.length;
  const totalRequests = routeTotal * MONTHS.length; // ONE request per route-month

  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Supabase key role: ${SERVICE_KEY_ROLE}`);
  console.log(`Origins (${ORIGINS_ALL.length}, all query the full ${DEST_IATAS.length}-destination network): ${ORIGINS_ALL.join(', ')}`);
  console.log(`  hubs (${HUB_AIRPORTS.length}): ${HUB_AIRPORTS.join(', ')}`);
  console.log(`  low-cost bases (${LOWCOST_AIRPORTS.length}): ${LOWCOST_AIRPORTS.join(', ')}`);
  console.log(`Flight months (${MONTHS.length}): ${MONTHS[0]} … ${MONTHS[MONTHS.length - 1]}  (MONTH_START=${MONTH_START}, MONTH_COUNT=${MONTH_COUNT})`);
  console.log(`Route-pairs: ${routeTotal}  ·  Flight requests: ${totalRequests} (1 per route-month)`);
  console.log(`At ${TARGET_INTERVAL_MS}ms/request (${(60000 / TARGET_INTERVAL_MS).toFixed(1)} req/min) ≈ ${Math.round(totalRequests * TARGET_INTERVAL_MS / 60000)} min\n`);

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

  let withPrice = 0;  // routes that got at least one price
  let noData = 0;     // routes with no price at all
  let reqDone = 0;
  let reqFailed = 0;  // requests the API never answered → nothing written, old value kept
  let reqBadBody = 0; // subset of the above: HTTP 200, but success:false or a non-array `data`
  let route = 0;
  // Pacing metrics for the summary: how fast we ACTUALLY went, and how often the API itself
  // was slower than the interval (those requests set the pace, we can't sleep negative time).
  let reqOverInterval = 0;
  let reqMsTotal = 0;
  const t0 = Date.now();
  const paceT0 = Date.now(); // start of the collection window, for the achieved req/min
  const etaMin = () => Math.round((totalRequests - reqDone) * TARGET_INTERVAL_MS / 60000);

  for (const { origin, dest } of routes) {
    route += 1;
    const stops = STOPS[dest];
    const flightHasStop = stops === 1; // long-haul default: cheapest 1+ stop
    const flightType = flightHasStop ? 'any' : 'direct';
    const byMonth = {};
    const okMonths = []; // months the API answered → the only ones we may prune
    for (const ym of MONTHS) {
      // ONE request per route-month, chosen by distance: near = direct, far = any.
      const reqT0 = Date.now();
      const { ok, min, offers, reason } = await fetchFlightMonth(origin, dest, ym, !flightHasStop);
      const reqMs = Date.now() - reqT0;
      reqDone += 1;
      reqMsTotal += reqMs;

      // EVERY buffer write below sits inside `if (ok)` ON PURPOSE — see the regression test
      // in fetch-prices.test.cjs. A FAILED request is not an observation: fetchFlightMonth
      // returns ok:false with min:null for a timeout, a non-2xx (429 included) or a malformed
      // body. Upserting that null would overwrite a REAL price with nothing, and price_history
      // would not even log the loss (hasPrice is false), so the destruction left no trace
      // anywhere. A failed route-month now writes nothing at all and keeps whatever the
      // previous run collected, until the next run re-asks.
      //
      // The asymmetry is deliberate: ok:true with min:null IS written. That is a genuine
      // observation — "this route-month really has no flights" — and about half of all
      // route-months legitimately look like that. Skipping it would freeze a price that has
      // since disappeared: the same silent-staleness bug, pointing the other way.
      if (ok) {
        okRouteMonths += 1;
        okMonths.push(ym);
        const pair = flightHasStop ? { direct: null, any: min } : { direct: min, any: null };
        byMonth[ym] = pair;
        // One prices row per route-month → upsert on PK (origin,dest,month).
        priceBuf.push({ origin, dest, month: ym, direct: pair.direct, any_stops: pair.any, updated_at: new Date().toISOString() });
        // Tee (observe only) the same values for the history snapshot — no effect on collection/write.
        snapshotRows.push({ origin, dest, month: ym, direct: pair.direct, any: pair.any, fetched_at: RUN_START_ISO });

        // price_history: log ONLY when this price differs from the baseline (or the route is new).
        // Compare each column against the loaded snapshot (null-normalized so null===null matches).
        // We DON'T log a change that has no price at all (both null) — a route that returned no
        // data is noise, not a real observation. Genuine prices (including a price appearing
        // where there was none) are logged.
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

        // COMBO selection → the offers buffer. From the full ≤500 response we keep the cheap
        // pool + one offer per distance-matrix target, tagged (in_cheap_pool / target_nights).
        // offersCollected counts what we STORE.
        const combo = selectCombo(offers, origin, dest);
        for (const o of combo) offerBuf.push(o);
        offersCollected += combo.length;
      } else {
        // Counted and reported, per route and in the summary. A failed request used to be
        // indistinguishable from "no flights" — which is exactly how the null-clobbering
        // stayed invisible for as long as it did.
        reqFailed += 1;
        if (reason === 'body') reqBadBody += 1;
      }

      // Sleep only the REMAINDER of the interval. The request we just made already consumed
      // part of it, so the spacing between two starts stays TARGET_INTERVAL_MS regardless of
      // how slow the API was — the whole point of the change. When the request alone outran
      // the interval there is nothing to sleep off; count it, because that is the only case
      // where TP's latency still lengthens the run.
      const remaining = TARGET_INTERVAL_MS - reqMs;
      if (remaining > 0) await sleep(remaining);
      else reqOverInterval += 1;
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
    // byMonth only holds ANSWERED months now, so a gap here means the API never replied for
    // those — surfaced per route so a bad patch is visible while the run is still going.
    const failedHere = MONTHS.length - okMonths.length;
    const failMark = failedHere ? `  ⚠ ${failedHere}/${MONTHS.length} req failed, kept previous` : '';
    console.log(`[route ${route}/${routeTotal}] ${origin}→${dest} (${flightType}): ${min}${failMark}   ~${etaMin()}m left`);
  }
  // End of the collection window — everything after this is flushing and reporting, so the
  // achieved rate is measured over exactly the part of the run that made requests.
  const paceMin = (Date.now() - paceT0) / 60000;

  await flushPrices(true);
  await flushHistory(true);
  await flushOffers(true); // safety net; per-route force-flushes normally drain it already

  // Additive history step — AFTER every Supabase TABLE write, so a Storage problem can never
  // affect what was collected. Its outcome is reported in the summary below.
  const snapshot = await uploadSnapshot(snapshotRows, SCOPE);

  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
  const avgOffers = okRouteMonths ? (offersCollected / okRouteMonths).toFixed(1) : '0';
  const achievedRpm = paceMin > 0 ? (reqDone / paceMin).toFixed(1) : '—';
  const avgReqMs = reqDone ? Math.round(reqMsTotal / reqDone) : 0;
  console.log('\n──────── summary ────────');
  console.log(`TP requests: ${totalRequests}`);
  console.log(`Origins: ${ORIGINS_ALL.length} (${HUB_AIRPORTS.length} hubs + ${LOWCOST_AIRPORTS.length} low-cost)`);
  console.log(`Destinations: ${DEST_IATAS.length}  ·  Route-pairs: ${routeTotal}  ·  Months: ${MONTHS.length}  ·  requests: ${totalRequests}`);
  console.log(`Routes with a price: ${withPrice}  ·  no data: ${noData}`);
  console.log(`Failed requests: ${reqFailed} of ${totalRequests} — nothing written for those, previous values kept`);
  console.log(`  of those, unusable 200s (success:false or non-array data): ${reqBadBody}  ·  transport/HTTP failures: ${reqFailed - reqBadBody}`);
  console.log(`Pace: target ${TARGET_INTERVAL_MS}ms (${(60000 / TARGET_INTERVAL_MS).toFixed(1)} req/min)  ·  achieved ${achievedRpm} req/min over ${paceMin.toFixed(1)} min  ·  avg request ${avgReqMs}ms`);
  console.log(`  requests slower than the interval: ${reqOverInterval} (those set the pace themselves — nothing left to sleep off)`);
  console.log(`Supabase prices: ${pricesWritten} rows written, ${priceWriteErrors} errors`);
  console.log(`Price changes: ${pricesChanged} changed/new  ·  ${pricesUnchanged} unchanged (baseline ${existingPrices.size})`);
  console.log(`Supabase price_history: ${historyWritten} rows written, ${historyWriteErrors} errors`);
  console.log(`Supabase offers: ${offersWritten} rows written, ${offerWriteErrors} errors`);
  console.log(`  offers collected: ${offersCollected}  ·  avg per route-month: ${avgOffers} (over ${okRouteMonths} answered route-months)`);
  console.log(`  stale offers pruned: ${offersDeleted}  ·  prune errors: ${offerDeleteErrors}`);
  console.log(snapshot.ok
    ? `Snapshot upload: OK → ${SNAPSHOT_BUCKET}/${snapshot.key}  (${snapshot.rows} rows, ${snapshot.kb} KB gz)`
    : `Snapshot upload: FAILED — ${snapshot.error}  (${snapshot.rows} rows${snapshot.kb ? `, ${snapshot.kb} KB gz` : ''} NOT uploaded)`);
  console.log(`Elapsed: ${elapsedMin} min`);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
