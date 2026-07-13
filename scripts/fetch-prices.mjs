// scripts/fetch-prices.mjs — NextOut Price ETL (standalone collector).
//
// Collects real Travelpayouts cache flight data and writes it to Supabase. Runs daily in
// GitHub Actions; can be run locally too. This is the ETL half of NextOut — it contains NO
// product logic (no ranking, no scoring, no UI), only the collection pipeline.
//
// TWO tables are filled from the SAME API responses:
//   • prices — one row per route-month = the cheapest price (the app reads this today).
//   • offers — every individual offer WHOLE (departure_at/return_at/nights/price/transfers/
//     airline). The v3 endpoint returns up to 30 dated offers per route-month; the old code
//     kept only Math.min and threw the rest away — losing which DAYS are cheap and mixing a
//     2-night fare into a 7-night Total. offers is a per-run SNAPSHOT: upsert on PK, then
//     stale rows (older than the run) are pruned, so it reflects current state, not a log.
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
import { HUB_AIRPORTS, LOWCOST_AIRPORTS, ORIGINS_ALL } from '../src/data/origins.js';
import { AVAILABLE_ROUTES } from '../src/data/routes.js';
import { DESTINATIONS } from '../src/data/destinations.js';

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

// Targets per origin: hubs → all destinations; low-cost → their curated map
// (intersected with the dataset so we never query a non-destination airport).
function targetsFor(origin) {
  const base = LOWCOST_AIRPORTS.includes(origin) ? (AVAILABLE_ROUTES[origin] ?? []) : DEST_IATAS;
  return base.filter((d) => d !== origin && STOPS[d] !== undefined);
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
    `&currency=eur&limit=30&token=${TP_TOKEN}`;
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

async function main() {
  // Plan the run so we can print totals and a live ETA.
  const plan = ORIGINS_ALL.map((o) => ({ origin: o, targets: targetsFor(o) }));
  const routeTotal = plan.reduce((s, p) => s + p.targets.length, 0);
  const totalRequests = routeTotal * MONTHS.length; // ONE request per route-month

  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Supabase key role: ${SERVICE_KEY_ROLE}`);
  console.log(`Origins (${ORIGINS_ALL.length}): ${ORIGINS_ALL.join(', ')}`);
  console.log(`  hubs (${HUB_AIRPORTS.length}, all dests): ${HUB_AIRPORTS.join(', ')}`);
  console.log(`  low-cost (${LOWCOST_AIRPORTS.length}, narrow map): ${LOWCOST_AIRPORTS.join(', ')}`);
  console.log(`Flight months (${MONTHS.length}): ${MONTHS[0]} … ${MONTHS[MONTHS.length - 1]}  (MONTH_START=${MONTH_START}, MONTH_COUNT=${MONTH_COUNT})`);
  console.log(`Route-pairs: ${routeTotal}  ·  Flight requests: ${totalRequests} (1 per route-month)`);
  console.log(`At ≥${PAUSE_MS}ms/request ≈ ${Math.round(totalRequests * PAUSE_MS / 60000)} min\n`);

  // Start-of-run timestamp. Rows written this run get updated_at >= this; stale-offer
  // pruning deletes only rows OLDER than it, so a fresh row is never removed.
  const RUN_START_ISO = new Date().toISOString();

  // Supabase write buffer + counters. We flush in BATCH-sized upserts, and flush
  // periodically during the (multi-hour) run so partial progress is persisted.
  const priceBuf = [];
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
        // Every individual offer → the offers buffer (only when the API actually answered).
        if (ok) {
          okRouteMonths += 1;
          okMonths.push(ym);
          for (const o of offers) offerBuf.push(o);
          offersCollected += offers.length;
        }
        await sleep(PAUSE_MS);
      }
      await flushPrices(false);

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
  await flushOffers(true); // safety net; per-route force-flushes normally drain it already

  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
  const avgOffers = okRouteMonths ? (offersCollected / okRouteMonths).toFixed(1) : '0';
  console.log('\n──────── summary ────────');
  console.log(`TP requests: ${totalRequests}`);
  console.log(`Origins: ${ORIGINS_ALL.length} (${HUB_AIRPORTS.length} hubs + ${LOWCOST_AIRPORTS.length} low-cost)`);
  console.log(`Destinations: ${DEST_IATAS.length}  ·  Route-pairs: ${routeTotal}  ·  Months: ${MONTHS.length}  ·  requests: ${totalRequests}`);
  console.log(`Routes with a price: ${withPrice}  ·  no data: ${noData}`);
  console.log(`Supabase prices: ${pricesWritten} rows written, ${priceWriteErrors} errors`);
  console.log(`Supabase offers: ${offersWritten} rows written, ${offerWriteErrors} errors`);
  console.log(`  offers collected: ${offersCollected}  ·  avg per route-month: ${avgOffers} (over ${okRouteMonths} answered route-months)`);
  console.log(`  stale offers pruned: ${offersDeleted}  ·  prune errors: ${offerDeleteErrors}`);
  console.log(`Elapsed: ${elapsedMin} min`);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
