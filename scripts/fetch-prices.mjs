// scripts/fetch-prices.mjs — NextOut Price ETL (standalone collector).
//
// Collects real Travelpayouts cache flight prices and writes them to Supabase
// (table `prices`). Runs daily in GitHub Actions; can be run locally too. This is
// the ETL half of NextOut — it contains NO product logic (no ranking, no scoring,
// no UI), only the flight-price-collection pipeline.
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

// 6 months of horizon, starting from the current month → ['YYYY-MM', ...].
const now = new Date();
const MONTHS = [];
for (let i = 0; i < 6; i += 1) {
  const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
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

// Min round-trip flight price for origin→dest in a single month (v3 cache).
// direct=true → cheapest non-stop only; direct=false → cheapest with any stops.
async function fetchFlightMonth(origin, dest, ym, direct) {
  const url =
    `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?origin=${origin}` +
    `&destination=${dest}&departure_at=${ym}&return_at=${ym}&direct=${direct}` +
    `&currency=eur&limit=30&token=${TP_TOKEN}`;
  const r = await getJson(url);
  if (r && r.success && Array.isArray(r.data) && r.data.length) {
    const prices = r.data.map((x) => x.price).filter((p) => typeof p === 'number' && p > 0);
    if (prices.length) return Math.round(Math.min(...prices));
  }
  return null;
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
  console.log(`Flight months (${MONTHS.length}): ${MONTHS.join(', ')}`);
  console.log(`Route-pairs: ${routeTotal}  ·  Flight requests: ${totalRequests} (1 per route-month)`);
  console.log(`At ≥${PAUSE_MS}ms/request ≈ ${Math.round(totalRequests * PAUSE_MS / 60000)} min\n`);

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
      const byMonth = {};
      for (const ym of MONTHS) {
        // ONE request per route-month, chosen by distance: near = direct, far = any.
        const price = await fetchFlightMonth(origin, dest, ym, !flightHasStop);
        reqDone += 1;
        const pair = flightHasStop ? { direct: null, any: price } : { direct: price, any: null };
        byMonth[ym] = pair;
        // One prices row per route-month → upsert on PK (origin,dest,month).
        priceBuf.push({ origin, dest, month: ym, direct: pair.direct, any_stops: pair.any, updated_at: new Date().toISOString() });
        await sleep(PAUSE_MS);
      }
      await flushPrices(false);

      const got = Object.values(byMonth).some((p) => p.direct != null || p.any != null);
      if (got) withPrice += 1; else noData += 1;
      const kind = flightHasStop ? 'any' : 'direct';
      const vals = Object.values(byMonth).map((p) => (flightHasStop ? p.any : p.direct)).filter((p) => p != null);
      const min = vals.length ? `€${Math.min(...vals)}` : '—';
      console.log(`[route ${route}/${routeTotal}] ${origin}→${dest} (${kind}): ${min}   ~${etaMin()}m left`);
    }
  }
  await flushPrices(true);

  const elapsedMin = ((Date.now() - t0) / 60000).toFixed(1);
  console.log('\n──────── summary ────────');
  console.log(`TP requests: ${totalRequests}`);
  console.log(`Origins: ${ORIGINS_ALL.length} (${HUB_AIRPORTS.length} hubs + ${LOWCOST_AIRPORTS.length} low-cost)`);
  console.log(`Destinations: ${DEST_IATAS.length}  ·  Route-pairs: ${routeTotal}  ·  Months: ${MONTHS.length}  ·  requests: ${totalRequests}`);
  console.log(`Routes with a price: ${withPrice}  ·  no data: ${noData}`);
  console.log(`Supabase prices: ${pricesWritten} rows written, ${priceWriteErrors} errors`);
  console.log(`Elapsed: ${elapsedMin} min`);
}

main().catch((e) => {
  console.error('Fatal error:', e);
  process.exit(1);
});
