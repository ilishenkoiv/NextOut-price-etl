// scripts/build-climate.mjs — ONE-OFF climate builder (rerun manually ~once a year; NOT in cron).
//
// For every destination in src/data/coords.js (DEST_COORDS) pulls 30 YEARS of daily weather
// from the Open-Meteo Historical Weather API (free, no key) and aggregates monthly climate
// normals into the `weather_climate` table the APP reads (the app never calls Open-Meteo).
//
//   daily: temperature_2m_max, precipitation_sum, sunshine_duration
//   per (iata, month): avg_tmax (°C), rain_days (≥1 mm), avg_sun_h, precip_mm (monthly sum)
//
// Output:
//   migrations/0003_weather_climate.sql — DDL + anon-select RLS + batched INSERTs (apply by hand)
//   data/weather-climate.json           — the same rows, for inspection
//   stdout                              — progress + the ☀️/⛅/☁️/🌧️ icon distribution (threshold calibration)
//
//   node scripts/build-climate.mjs --dry-run   # plan only, NO live calls
//   node scripts/build-climate.mjs             # full run (~800 requests, ~30 min)
//
// Free-tier limits (600 req/min, 10k/day): 6 chunks/dest × ~133 dests ≈ 800 requests — one day
// suffices with the 300 ms pause. Identical coordinates are fetched ONCE (NRT shares HND/Tokyo).

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEST_COORDS } from '../src/data/coords.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

const YEARS_START = 1995, YEARS_END = 2024;   // 30 years
const CHUNK_YEARS = 5;                        // 6 requests per destination
const PAUSE_MS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Dedupe identical coordinates (NRT == HND/Tokyo): fetch once, copy the rows.
const byCoord = new Map(); // "lat,lng" → [iata, ...]
for (const [iata, [lat, lng]] of Object.entries(DEST_COORDS)) {
  const k = `${lat.toFixed(3)},${lng.toFixed(3)}`;
  if (!byCoord.has(k)) byCoord.set(k, []);
  byCoord.get(k).push(iata);
}
const uniquePoints = [...byCoord.entries()];
const chunks = [];
for (let y = YEARS_START; y <= YEARS_END; y += CHUNK_YEARS) {
  chunks.push([y, Math.min(y + CHUNK_YEARS - 1, YEARS_END)]);
}
const totalRequests = uniquePoints.length * chunks.length;

console.log(`Destinations: ${Object.keys(DEST_COORDS).length} (${uniquePoints.length} unique coordinates)`);
console.log(`Range: ${YEARS_START}–${YEARS_END} in ${chunks.length} chunks of ${CHUNK_YEARS}y`);
console.log(`Requests: ${uniquePoints.length} × ${chunks.length} = ${totalRequests}`);
console.log(`Pause ${PAUSE_MS}ms → ≈${Math.round((totalRequests * (PAUSE_MS + 1200)) / 60000)} min total (incl. ~1.2s/response)`);
console.log(`Free limits: 600/min, 10k/day → fits in ONE day (${totalRequests} requests)`);
if (DRY_RUN) {
  console.log('\nDRY RUN — no live calls. Plan above. Run without --dry-run to execute.');
  process.exit(0);
}

async function fetchChunk(lat, lng, y1, y2) {
  const url =
    'https://archive-api.open-meteo.com/v1/archive' +
    `?latitude=${lat}&longitude=${lng}` +
    `&start_date=${y1}-01-01&end_date=${y2}-12-31` +
    '&daily=temperature_2m_max,precipitation_sum,sunshine_duration&timezone=UTC';
  // The free tier rate-limits in short bursts — retry 429/5xx with backoff (a transient
  // 429 killed the very first run). Give up only after all retries are exhausted.
  const waits = [5000, 15000, 30000, 60000, 120000];
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < waits.length) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      const wait = Math.max(waits[attempt], retryAfter || 0);
      console.warn(`  HTTP ${res.status} for ${lat},${lng} ${y1}-${y2} — retry in ${Math.round(wait / 1000)}s (attempt ${attempt + 1}/${waits.length})`);
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${lat},${lng} ${y1}-${y2}`);
  }
}

// Aggregate one coordinate → 12 monthly rows.
function aggregate(daily) {
  const t = daily.time, tmax = daily.temperature_2m_max, pr = daily.precipitation_sum, sun = daily.sunshine_duration;
  const acc = Array.from({ length: 13 }, () => ({ tmaxSum: 0, n: 0, rain: 0, sunSec: 0, precip: 0 }));
  for (let i = 0; i < t.length; i++) {
    const m = Number(t[i].slice(5, 7));
    const a = acc[m];
    if (typeof tmax[i] === 'number') { a.tmaxSum += tmax[i]; a.n++; }
    if (typeof pr[i] === 'number') {
      a.precip += pr[i];
      if (pr[i] >= 1) a.rain++;
    }
    if (typeof sun[i] === 'number') a.sunSec += sun[i];
  }
  const years = YEARS_END - YEARS_START + 1;
  const rows = [];
  for (let m = 1; m <= 12; m++) {
    const a = acc[m];
    if (!a.n) continue;
    rows.push({
      month: m,
      avg_tmax: Math.round((a.tmaxSum / a.n) * 10) / 10,
      rain_days: Math.round((a.rain / years) * 10) / 10,
      avg_sun_h: Math.round((a.sunSec / 3600 / a.n) * 10) / 10,
      precip_mm: Math.round(a.precip / years),
    });
  }
  return rows;
}

// Icon distribution for the calibration report (same thresholds as the app's CLIMATE_ICON).
function iconOf(r) {
  if (r.rain_days >= 18 || r.precip_mm >= 250) return '🌧️';
  if (r.avg_sun_h >= 6 && r.rain_days <= 9) return '☀️';
  if (r.avg_sun_h >= 4 && r.rain_days <= 14) return '⛅';
  return '☁️';
}

const allRows = []; // { iata, month, avg_tmax, rain_days, avg_sun_h, precip_mm }
const dist = { '🌧️': 0, '☀️': 0, '⛅': 0, '☁️': 0 };
let done = 0;
for (const [coord, iatas] of uniquePoints) {
  const [lat, lng] = coord.split(',').map(Number);
  const daily = { time: [], temperature_2m_max: [], precipitation_sum: [], sunshine_duration: [] };
  for (const [y1, y2] of chunks) {
    const part = await fetchChunk(lat, lng, y1, y2);
    daily.time.push(...part.daily.time);
    daily.temperature_2m_max.push(...part.daily.temperature_2m_max);
    daily.precipitation_sum.push(...part.daily.precipitation_sum);
    daily.sunshine_duration.push(...part.daily.sunshine_duration);
    done++;
    if (done % 60 === 0) console.log(`  …${done}/${totalRequests} requests`);
    await sleep(PAUSE_MS);
  }
  const monthly = aggregate(daily);
  for (const iata of iatas) {
    for (const r of monthly) {
      allRows.push({ iata, ...r });
      dist[iconOf(r)]++;
    }
  }
  console.log(`${iatas.join('+')} (${coord}) — ${monthly.length} monthly rows × ${iatas.length} dest(s)`);
}

// ── artifacts ─────────────────────────────────────────────────────────────────
await mkdir(path.join(ROOT, 'data'), { recursive: true });
await writeFile(path.join(ROOT, 'data', 'weather-climate.json'), JSON.stringify(allRows, null, 2));

const DDL = `-- 0003_weather_climate.sql — 30-year climate normals per destination × month
-- (Open-Meteo Historical Weather API, one-off build via scripts/build-climate.mjs).
-- The APP reads this table; it never calls Open-Meteo. Data license: CC BY 4.0
-- (attribution is shown in the app's Credits block).
--
-- ⚠️ RUN THIS in the Supabase SQL editor. Anon may SELECT (the app reads), never write.

create table if not exists public.weather_climate (
  iata       text        not null,
  month      smallint    not null check (month between 1 and 12),
  avg_tmax   numeric(4,1) not null,   -- °C, 30-year mean of daily Tmax
  rain_days  numeric(4,1) not null,   -- mean days/month with ≥ 1 mm precipitation
  avg_sun_h  numeric(4,1) not null,   -- mean sunshine hours/day
  precip_mm  integer     not null,    -- mean monthly precipitation sum, mm
  updated_at timestamptz not null default now(),
  primary key (iata, month)
);

alter table public.weather_climate enable row level security;

grant usage  on schema public                 to anon;
grant select on table public.weather_climate  to anon;

drop policy if exists "anon read weather_climate" on public.weather_climate;
create policy "anon read weather_climate"
  on public.weather_climate
  for select
  to anon
  using (true);

truncate public.weather_climate;
`;

const BATCH = 400;
let sql = DDL + '\n';
for (let i = 0; i < allRows.length; i += BATCH) {
  const batch = allRows.slice(i, i + BATCH);
  sql += 'insert into public.weather_climate (iata, month, avg_tmax, rain_days, avg_sun_h, precip_mm) values\n';
  sql += batch.map((r) => `  ('${r.iata}', ${r.month}, ${r.avg_tmax}, ${r.rain_days}, ${r.avg_sun_h}, ${r.precip_mm})`).join(',\n');
  sql += ';\n\n';
}
sql += "notify pgrst, 'reload schema';\n";
await writeFile(path.join(ROOT, 'migrations', '0003_weather_climate.sql'), sql);

console.log(`\n✓ ${allRows.length} rows (${Object.keys(DEST_COORDS).length} dests × 12 months)`);
console.log('Icon distribution (city-months): ' +
  Object.entries(dist).map(([k, v]) => `${k} ${v} (${Math.round((v / allRows.length) * 100)}%)`).join('  '));
console.log('Artifacts: migrations/0003_weather_climate.sql, data/weather-climate.json');
