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
//   node scripts/build-climate.mjs             # one PASS (resumable — rerun until 133/133)
//
// EXPECT SEVERAL PASSES. Open-Meteo's archive rate-limits hard; a pass collects what it can,
// checkpoints every city to data/weather-climate.json, and the next pass resumes from there.
// The SQL migration is a TRUNCATE + full reload, so it is only (re)generated once coverage is
// complete — a partial pass never overwrites it. Identical coordinates are fetched ONCE and
// their rows copied to every IATA sharing the point, so unique coordinates ≤ destinations.

import { writeFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEST_COORDS } from '../src/data/coords.js';
import { CITIES } from '../src/data/cities.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DRY_RUN = process.argv.includes('--dry-run');

const YEARS_START = 1995, YEARS_END = 2024;   // 30 years
const CHUNK_YEARS = 10;                       // 3 bigger requests per destination (fewer 429s)

// ── Pacing / retry knobs — tune these two, nothing else ──────────────────────
// The archive endpoint's real minutely limit is FAR below the advertised 600/min: at 300ms
// (~37 req/min) every request bounced, and 5s (~12/min) still hit bursts mid-pass. This job
// runs about once a year, so slow is free: 8s ≈ 7 req/min.
const PAUSE_MS = 8000;
// Per-chunk backoff ladder before that chunk is given up and refilled by the next pass.
// Sum ≈ 33 min of patience per chunk (was ~18 min with a 600s ceiling).
const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 600_000, 900_000];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOTAL_DESTS = Object.keys(DEST_COORDS).length;
// Display name for the progress line; cities.js may not cover every coord key.
const nameOf = (iata) => CITIES[iata]?.city ?? '';

// Dedupe identical coordinates: fetch once, copy the rows to every IATA on that point.
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

console.log(`Destinations: ${TOTAL_DESTS} (${uniquePoints.length} unique coordinates)`);
console.log(`Range: ${YEARS_START}–${YEARS_END} in ${chunks.length} chunks of ${CHUNK_YEARS}y`);
console.log(`Requests: ${uniquePoints.length} × ${chunks.length} = ${totalRequests} (for a FULL pass from scratch)`);
console.log(`Pause ${PAUSE_MS}ms → ≈${Math.round((totalRequests * (PAUSE_MS + 1200)) / 60000)} min if nothing is rate-limited`);
console.log(`Backoff ladder: ${BACKOFF_MS.map((w) => w / 1000).join('s / ')}s → ≈${Math.round(BACKOFF_MS.reduce((a, b) => a + b, 0) / 60000)} min patience per chunk`);
if (DRY_RUN) {
  console.log('\nDRY RUN — no live calls. Plan above. Run without --dry-run to execute.');
  process.exit(0);
}

// `label` is for logging only (e.g. "HND 1995-2004") — it never affects the request.
async function fetchChunk(lat, lng, y1, y2, label) {
  const url =
    'https://archive-api.open-meteo.com/v1/archive' +
    `?latitude=${lat}&longitude=${lng}` +
    `&start_date=${y1}-01-01&end_date=${y2}-12-31` +
    '&daily=temperature_2m_max,precipitation_sum,sunshine_duration&timezone=UTC';
  // The free tier rate-limits in bursts and penalizes with longer windows — back off along
  // BACKOFF_MS, then give up on this chunk: the next pass refills it.
  const chunkId = label ?? `${lat},${lng} ${y1}-${y2}`;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url);
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < BACKOFF_MS.length) {
      const retryAfter = Number(res.headers.get('retry-after')) * 1000;
      const wait = Math.max(BACKOFF_MS[attempt], retryAfter || 0);
      console.warn(`  rate-limited, backing off ${Math.round(wait / 1000)}s (chunk ${chunkId}) — HTTP ${res.status}, attempt ${attempt + 1}/${BACKOFF_MS.length}`);
      await sleep(wait);
      continue;
    }
    throw new Error(`HTTP ${res.status} for ${chunkId}`);
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

// Icon distribution for the calibration report (same thresholds as the app's CLIMATE_ICON
// in src/lib/climate.ts — keep the two in sync; this copy is LOG-ONLY, it never touches
// the collected data). 🌧️ needs real water, not just a day count (rain_days counts every
// day with ≥ 1 mm, so a 10-minute shower scores like a downpour); ☁️ means low sun only.
function iconOf(r) {
  if ((r.rain_days >= 18 && r.precip_mm >= 150) || r.precip_mm >= 250) return '🌧️';
  if (r.avg_sun_h >= 6 && r.rain_days <= 9) return '☀️';
  if (r.avg_sun_h >= 4) return '⛅';
  return '☁️';
}

// ── Main loop (RESUMABLE) ─────────────────────────────────────────────────────
// Progress is persisted after EVERY destination into data/weather-climate.json, so a
// rate-limited / interrupted run resumes where it stopped — just run the script again.
// A chunk that exhausts its retries is SKIPPED (logged) and the run continues; the next
// run refills it. Partial artifacts are always written — coverage is reported honestly.

const PROGRESS_PATH = path.join(ROOT, 'data', 'weather-climate.json');
let allRows = [];
try {
  allRows = JSON.parse(await readFile(PROGRESS_PATH, 'utf8'));
} catch { /* first pass */ }
const doneIatas = new Set(allRows.map((r) => r.iata));

const dist = { '🌧️': 0, '☀️': 0, '⛅': 0, '☁️': 0 };
for (const r of allRows) dist[iconOf(r)]++;

console.log(
  doneIatas.size
    ? `\nResuming: ${doneIatas.size}/${TOTAL_DESTS} already collected, ${TOTAL_DESTS - doneIatas.size} remaining.\n`
    : `\nFirst pass: 0/${TOTAL_DESTS} collected, ${TOTAL_DESTS} remaining.\n`
);

const missingIatas = () => Object.keys(DEST_COORDS).filter((i) => !doneIatas.has(i));

const failedChunks = [];
let done = 0; // requests issued this pass

// End-of-pass summary. Runs on a clean finish AND on Ctrl-C / crash, so the pass always
// reports honestly where it stopped. Guarded so it prints exactly once.
let summaryPrinted = false;
function printSummary(reason) {
  if (summaryPrinted) return;
  summaryPrinted = true;
  const missing = missingIatas();
  console.log(`\n── PASS SUMMARY (${reason}) ─────────────────────────────────`);
  console.log(`Collected: ${doneIatas.size}/${TOTAL_DESTS} destinations (${allRows.length} rows, ${done} requests this pass)`);
  if (missing.length) {
    console.log(`Still missing (${missing.length}): ${missing.join(' ')}`);
    console.log('→ rerun the script to continue; it resumes from the checkpoint.');
  } else {
    console.log('Still missing: none — coverage is COMPLETE.');
  }
  console.log(failedChunks.length
    ? `Failed chunks this pass: ${failedChunks.length} (listed above) — next pass refills them.`
    : 'Failed chunks this pass: none.');
}

process.on('SIGINT', () => { printSummary('interrupted — Ctrl-C'); process.exit(130); });
process.on('SIGTERM', () => { printSummary('terminated'); process.exit(143); });
try {
  for (const [coord, iatas] of uniquePoints) {
    if (iatas.every((i) => doneIatas.has(i))) continue; // already collected in a previous pass
    const [lat, lng] = coord.split(',').map(Number);
    const label = iatas.join('+');
    const daily = { time: [], temperature_2m_max: [], precipitation_sum: [], sunshine_duration: [] };
    let ok = true;
    for (const [y1, y2] of chunks) {
      try {
        const part = await fetchChunk(lat, lng, y1, y2, `${label} ${y1}-${y2}`);
        daily.time.push(...part.daily.time);
        daily.temperature_2m_max.push(...part.daily.temperature_2m_max);
        daily.precipitation_sum.push(...part.daily.precipitation_sum);
        daily.sunshine_duration.push(...part.daily.sunshine_duration);
      } catch (err) {
        console.error(`[${doneIatas.size}/${TOTAL_DESTS}] ${label} — FAILED after retries (will retry next pass): ${err.message}`);
        failedChunks.push(`${label} ${y1}-${y2}`);
        ok = false;
        break;
      }
      done++;
      await sleep(PAUSE_MS);
    }
    if (!ok) continue;
    const monthly = aggregate(daily);
    for (const iata of iatas) {
      for (const r of monthly) {
        allRows.push({ iata, ...r });
        dist[iconOf(r)]++;
      }
      doneIatas.add(iata);
    }
    const city = iatas.map(nameOf).filter(Boolean).join('+');
    console.log(
      `[${doneIatas.size}/${TOTAL_DESTS}] ${label}${city ? ` ${city}` : ''} — collected (${monthly.length} months)` +
      ` | remaining: ${TOTAL_DESTS - doneIatas.size}`
    );
    await mkdir(path.join(ROOT, 'data'), { recursive: true });
    await writeFile(PROGRESS_PATH, JSON.stringify(allRows, null, 2));
  }
} finally {
  if (failedChunks.length) {
    console.log(`\n⚠ ${failedChunks.length} chunk(s) failed this pass — rerun the script to refill:`);
    for (const f of failedChunks) console.log(`  ${f}`);
  }
  printSummary('loop ended');
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

// ⚠️ The migration starts with `truncate public.weather_climate` — writing it from a PARTIAL
// pass would stage a file that WIPES the table and reloads only the cities collected so far.
// So it is generated ONLY at full coverage. The JSON checkpoint above is always written
// (partial is exactly what it is for); any stale SQL on disk is left untouched.
const SQL_PATH = path.join(ROOT, 'migrations', '0003_weather_climate.sql');
const complete = doneIatas.size === TOTAL_DESTS;

if (!complete) {
  const missing = missingIatas();
  console.log(`\n⏸  SQL NOT regenerated — coverage ${doneIatas.size}/${TOTAL_DESTS} (${missing.length} destination(s) still missing).`);
  console.log(`    The migration truncates and reloads the whole table, so it is only written at ${TOTAL_DESTS}/${TOTAL_DESTS}.`);
  console.log('    Checkpoint saved: data/weather-climate.json — rerun the script to continue.');
} else {
  const BATCH = 400;
  let sql = DDL + '\n';
  for (let i = 0; i < allRows.length; i += BATCH) {
    const batch = allRows.slice(i, i + BATCH);
    sql += 'insert into public.weather_climate (iata, month, avg_tmax, rain_days, avg_sun_h, precip_mm) values\n';
    sql += batch.map((r) => `  ('${r.iata}', ${r.month}, ${r.avg_tmax}, ${r.rain_days}, ${r.avg_sun_h}, ${r.precip_mm})`).join(',\n');
    sql += ';\n\n';
  }
  sql += "notify pgrst, 'reload schema';\n";
  await writeFile(SQL_PATH, sql);
  console.log(`\n✓ COMPLETE — ${allRows.length} rows (${TOTAL_DESTS} dests × 12 months)`);
  console.log('Artifacts: migrations/0003_weather_climate.sql, data/weather-climate.json');
  console.log('Next: apply migrations/0003_weather_climate.sql in the Supabase SQL editor.');
}

if (allRows.length) {
  console.log('Icon distribution (city-months): ' +
    Object.entries(dist).map(([k, v]) => `${k} ${v} (${Math.round((v / allRows.length) * 100)}%)`).join('  '));
}
