// scripts/fetch-prices.mjs — NextOut Price ETL (standalone collector).
//
// Collects flight price data from Travelpayouts and writes it to Supabase. Runs in GitHub
// Actions; can be run locally too. Contains NO product logic (no ranking, no scoring, no
// UI), only the collection pipeline.
//
//   PowerShell:  $env:TP_TOKEN="..."; $env:SUPABASE_SERVICE_KEY="..."; node scripts/fetch-prices.mjs
//   bash:        TP_TOKEN=... SUPABASE_SERVICE_KEY=... node scripts/fetch-prices.mjs
//
// Secrets come from env ONLY — never hardcode or commit them:
//   TP_TOKEN             — Travelpayouts API token (required).
//   SUPABASE_SERVICE_KEY — Supabase service-role key, writes past RLS (required, SECRET).
//   SUPABASE_URL         — project URL (public, NOT a secret; default below).
//
// Hotel price segments (`hotels_segments`) are NOT collected here and must not be added
// back: they are static curated data maintained directly in Supabase, and the former
// Hotellook integration was removed because the upstream endpoints (engine.hotellook.com)
// were discontinued and return 404 on everything.

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { gzipSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
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

// Fixed INTERVAL, not a fixed pause. Sleeping a fixed time AFTER each response makes the real
// spacing HTTP + pause, so the run's length is set by the upstream API's latency rather than
// by us — when upstream slowed, sweeps overran and runs were cancelled on timeout. We time the
// request and sleep only the remainder of TARGET_INTERVAL_MS, so a slower API costs nothing
// until it exceeds the interval outright. The default sits deliberately under the upstream
// rate ceiling: do NOT lower it against the live API. TP_TARGET_INTERVAL_MS exists for CI and
// small re-runs only.
const TARGET_INTERVAL_MS = Number(process.env.TP_TARGET_INTERVAL_MS) || 1091;
// Deliberately short. Nothing useful ever arrives late — upstream answers well inside a second
// and the observed failures are 502/503 bursts, so a long ceiling only buys dead waiting time.
const TIMEOUT_MS = 8000;
const BATCH = 500; // rows per Supabase upsert — batched, not row-by-row
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pad = (n) => String(n).padStart(2, '0');
// The calendar month AFTER a 'YYYY-MM'. Used as the SECOND return window (§edge-months): a trip
// that departs late in `ym` and returns early next month is a real, bookable trip that a single
// return_at=ym request never returns, so we also ask return_at=nextMonthYM(ym) for the same
// departure month. String math, no Date round-trip (no timezone shift on the month boundary).
function nextMonthYM(ym) {
  const [y, m] = ym.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

// Month window, parameterized so a long horizon can be split across sequential CI jobs
// without exceeding either the hosted-runner job limit or the upstream rate limit.
//   MONTH_START — 1-based offset from the current month (default 1). START=1 → the NEXT
//                 full month; the current, partially-elapsed month is never collected
//                 (matches the app's horizon — lib/prices.ts horizonMonths).
//   MONTH_COUNT — how many consecutive months to collect (default 6).
// The workflow sets both per job; see it for the split actually used in CI.
const MONTH_START = Number(process.env.MONTH_START) || 1;
const MONTH_COUNT = Number(process.env.MONTH_COUNT) || 6;

// ── Manual-measurement knobs (workflow_dispatch inputs only) ──────────────────
// They shrink the route plan so the fallback yield can be measured on a short run WITHOUT
// touching the nightly. On a scheduled run BOTH env vars are absent (the workflow passes the
// empty string), which decodes to "no cap / keep all" — so the nightly plan is bit-for-bit
// what it was. They are applied to the SHUFFLED plan in main(), never to catalog order, so a
// capped run samples the same spread of the network the nightly would, not one edge of it.
//   MAX_ROUTES      — hard cap on route-pairs this job walks (0 = no cap).
//   SAMPLE_FRACTION — keep this fraction (0 < f < 1) of the planned pairs (1 = all).
const MAX_ROUTES = Math.max(0, Math.trunc(Number(process.env.MAX_ROUTES) || 0));
const SAMPLE_FRACTION = (() => {
  const f = Number(process.env.SAMPLE_FRACTION);
  return Number.isFinite(f) && f > 0 && f < 1 ? f : 1;
})();

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

// The WHOLE horizon, independent of which slice this job collects — months 1..12 from the
// current one. Used only to judge whether a route-pair is dead: "no price in ANY month" has
// to mean the full horizon, not the three months this particular job happens to hold. It
// also excludes months that have fallen out of the horizon, whose stale rows would otherwise
// keep a long-dead pair looking alive. HORIZON_MONTH_COUNT tracks the app's `horizonMonths`.
const HORIZON_MONTH_COUNT = Number(process.env.HORIZON_MONTH_COUNT) || 12;
const HORIZON_MONTHS = new Set();
for (let i = 0; i < HORIZON_MONTH_COUNT; i += 1) {
  const d = new Date(now.getFullYear(), now.getMonth() + 1 + i, 1);
  HORIZON_MONTHS.add(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
}

// How much of the dead-pair list is re-checked per run: 1/7, so a full pass takes a week.
const DEAD_SLICES = 7;

// ── Describing a failed call without dumping the response body ───────────────
// postgrest-js puts the RAW response text into error.message whenever the body is not JSON.
// A Cloudflare 5xx is a full HTML page, so `${error.message}` printed ~100 lines of markup
// into the middle of a run log and buried everything around it. Every error path that has an
// upstream body behind it goes through here instead.
//   • the HTTP status is always printed — it is the one field that actually identifies the
//     failure (520 = origin unreachable, 503 = overloaded, 4xx = our request);
//   • the body is capped at BODY_PREVIEW characters on ONE line;
//   • a body starting with '<' (HTML, `<!DOCTYPE`, an XML error doc) is not printed at all —
//     there is never anything in it we act on.
const BODY_PREVIEW = 200;
function previewBody(raw) {
  const s = (typeof raw === 'string' ? raw : String(raw ?? '')).trim();
  if (!s) return '(no message)';
  if (s.startsWith('<')) return '(HTML error page)';
  const flat = s.replace(/\s+/g, ' ');
  return flat.length > BODY_PREVIEW ? `${flat.slice(0, BODY_PREVIEW)}… (${flat.length} chars)` : flat;
}
function describeError(status, err, rowCount = null) {
  const code = status == null ? 'no HTTP status'
    : status === 0 ? 'HTTP — (request never completed)'
      : `HTTP ${status}`;
  const body = previewBody(typeof err?.message === 'string' ? err.message : err);
  return `${code}${rowCount == null ? '' : `, ${rowCount} rows`}: ${body}`;
}

// The HTTP status of a failed Supabase call. postgrest-js carries it on the RESULT
// ({ data, error, status }); storage-js carries it on the ERROR. A thrown request has
// neither, and postgrest-js reports status 0 when fetch itself never completed.
function httpStatusOf(result, err) {
  if (typeof result?.status === 'number') return result.status;
  if (typeof err?.status === 'number') return err.status;
  return null;
}

// ── Retrying a Supabase WRITE ────────────────────────────────────────────────
// The read side has been protected for a while — a failed Travelpayouts request writes
// nothing and the previous value survives. The WRITE side had no such symmetry: Supabase
// answered a 520 through Cloudflare (origin unreachable), an upsert of 30 offers failed, the
// buffer was already spliced, and those rows were gone for good. The next run does not pick
// them up, because nothing records that they were owed.
//
// Note that supabase-js does not cover this itself: postgrest-js retries 520 only for
// GET/HEAD/OPTIONS, deliberately, since it cannot know whether a POST is safe to repeat.
// Ours are: prices and offers upsert on their primary keys, the prune is a bounded DELETE,
// and the Storage upload is upsert:true. Repeating any of them lands on the same state.
// price_history is the one INSERT — a repeat after a write that secretly succeeded could
// duplicate an observation. That is acceptable and it is the cheap direction: the table is
// an append-only log of changes, a duplicated row reads as the same price observed twice,
// and losing the row loses the change forever.
//
// Only TRANSIENT failures are repeated: a request that never completed, and any HTTP 5xx
// (520, 502, 503 …). A 4xx is our own data or our own rights — a repeat changes nothing and
// only spends time.
const WRITE_RETRY_BACKOFF_MS = [2000, 5000, 15000];
const WRITE_MAX_ATTEMPTS = WRITE_RETRY_BACKOFF_MS.length + 1;

function isTransientWriteFailure(status) {
  if (status == null) return true; // thrown before any response existed → network/socket
  if (status === 0) return true;   // postgrest-js: fetch itself never completed
  return status >= 500;            // 5xx, Cloudflare's 52x included
}

// ── Write-failure tally, reported at the very end of the job ─────────────────
// A definitive write failure is one line somewhere inside a six-hour log. The run that lost
// 30 offers to a Cloudflare 520 said so at 03:41 and then looked healthy for another five
// hours; nobody scrolled back. Every failure is therefore also counted here and reprinted
// at the end under a marker that greps in one word — ALWAYS, including when the count is
// zero. An explicit 0 is evidence that nothing was lost; a missing line is only silence,
// and silence is what the 520 already gave us.
//
// Two kinds, kept apart because they call for different reactions:
//   permanent — HTTP 4xx, never retried. Our payload or our rights are wrong, and every
//               following run fails identically until someone changes something.
//   exhausted — transient (no response / 5xx) that survived all WRITE_MAX_ATTEMPTS. The
//               data is gone, but the cause is on their side and may already be over.
// Counted per CALL and per ROW: rows are the damage, calls tell one lost 500-row batch from
// ten lost ones. This is bookkeeping only — nothing here changes what is retried or written.
const WRITE_LOSS_MARKER = 'WRITE-LOSS';

// Print order, and the reason the zero lines exist at all: seeded up front so every target
// reports even in a run where it never failed. `offers_prune` is separate from `offers` —
// it deletes rather than writes, so folding it in would inflate the rows-lost number of the
// table with an operation that loses no rows.
const WRITE_LOSS_TARGETS = ['prices', 'offers', 'offers_prune', 'price_history', 'storage_snapshot'];
const newWriteLossEntry = () => ({
  permanent: { calls: 0, rows: 0, unsized: 0 },
  exhausted: { calls: 0, rows: 0, unsized: 0 },
});
const writeLosses = new Map(WRITE_LOSS_TARGETS.map((t) => [t, newWriteLossEntry()]));

// Record ONE definitively-failed write. `rows` is what the caller knows it lost; pass null
// where the count is not knowable at the call site (the prune deletes an unknown number of
// rows) — those calls are tallied as `unsized` instead of being quietly folded in as 0.
// An unregistered target still lands in the summary, so a future call site that forgets its
// name is visible rather than uncounted.
function recordWriteLoss(target, kind, rows) {
  const name = target || 'unspecified';
  if (!writeLosses.has(name)) writeLosses.set(name, newWriteLossEntry());
  const bucket = writeLosses.get(name)[kind];
  bucket.calls += 1;
  if (typeof rows === 'number') bucket.rows += rows;
  else bucket.unsized += 1;
}

const formatWriteLoss = (k) =>
  `${k.calls} calls, ${k.rows} rows${k.unsized ? ` (+${k.unsized} of unknown size)` : ''}`;

// A qualifier appended to ONE target's summary line. It exists because calls/rows can only say
// "this write never landed", and the snapshot has a second failure mode they cannot express: the
// upload succeeds and the object is malformed. That is not a lost row — the prices themselves
// went into `prices` regardless — so counting it under permanent/exhausted would overstate the
// damage and corrupt the rows-never-written total. It rides on the SAME line as
// `storage_snapshot` rather than in a summary of its own: one marker, one verdict, one grep.
const writeLossNotes = new Map();
function noteWriteLoss(target, note) {
  writeLossNotes.set(target, note);
}

// One line per target plus a TOTAL, every line starting with WRITE_LOSS_MARKER so the whole
// verdict is `grep WRITE-LOSS` on the job log.
function logWriteLossSummary() {
  const pad = Math.max('TOTAL'.length, ...[...writeLosses.keys()].map((t) => t.length));
  let calls = 0;
  let rows = 0;
  let unsized = 0;
  for (const [target, e] of writeLosses) {
    calls += e.permanent.calls + e.exhausted.calls;
    rows += e.permanent.rows + e.exhausted.rows;
    unsized += e.permanent.unsized + e.exhausted.unsized;
    // No note means the step never got far enough to have a verdict — for the snapshot that is
    // itself information, and it reads differently from an explicit "valid".
    const note = writeLossNotes.get(target);
    console.log(`${WRITE_LOSS_MARKER} ${target.padEnd(pad)}  permanent ${formatWriteLoss(e.permanent)}  ·  exhausted ${formatWriteLoss(e.exhausted)}${note ? `  ·  ${note}` : ''}`);
  }
  // TOTAL stays rows-never-written and nothing else. A malformed-but-uploaded snapshot is
  // deliberately absent from it — see writeLossNotes — and is read off its own target line.
  console.log(`${WRITE_LOSS_MARKER} ${'TOTAL'.padEnd(pad)}  ${calls} failed writes, ${rows} rows never written${unsized ? `, ${unsized} calls of unknown row count` : ''}`);
}

// Run one Supabase write, repeating it while it fails transiently. `run` must return a
// supabase-js result ({ data, error, status }) or throw. Returns the same shape plus `ok`,
// `attempts` and the last error already formatted for the log. `where` names the target and
// the row count for the end-of-job tally — it affects nothing but that tally.
async function writeWithRetry(label, run, where = {}) {
  for (let attempt = 1; ; attempt += 1) {
    let res = null;
    let err = null;
    let threw = false;
    try {
      res = await run();
      err = res?.error ?? null;
    } catch (e) {
      threw = true;
      err = e;
    }
    if (!err) return { ok: true, data: res?.data ?? null, error: null, attempts: attempt };

    const status = threw ? httpStatusOf(null, err) : httpStatusOf(res, err);
    const why = describeError(status, err);
    const transient = threw || isTransientWriteFailure(status);
    if (!transient || attempt >= WRITE_MAX_ATTEMPTS) {
      // The single place a write is given up on, so the tally cannot miss a call site.
      recordWriteLoss(where.target, transient ? 'exhausted' : 'permanent', where.rows ?? null);
      return { ok: false, data: null, error: err, why, attempts: attempt, transient };
    }
    const wait = WRITE_RETRY_BACKOFF_MS[attempt - 1];
    console.warn(`    ⚠ ${label} — ${why}  · attempt ${attempt}/${WRITE_MAX_ATTEMPTS}, retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
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
    // Also capped: a 200 whose body is HTML fails in res.json(), and Node's parse error
    // quotes the start of that body back at us.
    console.warn(`    request failed: ${previewBody(e.message)}`);
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
// `retYm` is the RETURN month window, default the same month. §edge-months requests the SAME
// departure month `ym` twice — return_at=ym and return_at=nextMonthYM(ym) — so a late-month
// departure returning early next month is collected too. The CELL is always the DEPARTURE month:
// offers are clamped to departure-in-`ym` (§dedup), so the boundary window never files a trip
// under a neighbouring month, and the same trip from two windows collapses on the offers PK.
async function fetchFlightMonth(origin, dest, ym, direct, retYm = ym) {
  const url =
    `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?origin=${origin}` +
    `&destination=${dest}&departure_at=${ym}&return_at=${retYm}&direct=${direct}` +
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
    // Capped like every other upstream string we print — it is somebody else's field.
    const why = typeof r.error === 'string' ? ` error="${previewBody(r.error)}"` : '';
    console.warn(`    unusable 200 ${origin}→${dest} ${ym} (${direct ? 'direct' : 'any'}): success=${r.success}, data=${shape}${why}`);
    return { ok: false, min: null, offers: [], reason: 'body' };
  }

  // `offers` table: parse & validate each item. The CELL is the DEPARTURE month: an item whose
  // departure falls outside `ym` (a boundary-day spill, or the return window bleeding a stray
  // departure across the month line) is dropped, so every row filed here belongs to cell `ym`.
  const flightType = direct ? 'direct' : 'any';
  const nowIso = new Date().toISOString();
  const offers = [];
  for (const x of r.data) {
    const departure_at = toDateOnly(x.departure_at);
    const price = typeof x.price === 'number' ? Math.round(x.price) : NaN;
    if (!departure_at || !(price > 0)) continue; // validation (1e): needs a dep date & price>0
    if (departure_at.slice(0, 7) !== ym) continue; // §dedup: keep the cell strictly = departure month
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
  // `prices` min over the SAME departure-in-`ym` offers, so the cell price and its offers agree
  // (and a cross-month trip from the boundary window can set it).
  const min = offers.length ? Math.min(...offers.map((o) => o.price)) : null;
  return { ok: true, min, offers };
}

// Probe ONE cell for ONE flight type over BOTH return windows (§edge-months): return_at=ym and
// return_at=nextMonthYM(ym), same departure month. `paced` wraps each TP request with the run's
// pacing + metrics. Returns the merged result for the cell:
//   • a price from either window → ok:true with that min (a window that FAILED does not veto a
//     price the other window really returned);
//   • both windows answered and neither had a price → ok:true, min:null (a genuine "no flights");
//   • no price AND a window failed → ok:false (INCONCLUSIVE — §first-edit: an empty/failed attempt
//     must not clobber a known price, so nothing is written and the previous value is kept).
async function probeType(origin, dest, ym, retNext, direct, paced) {
  const w1 = await paced(() => fetchFlightMonth(origin, dest, ym, direct, ym));
  const w2 = await paced(() => fetchFlightMonth(origin, dest, ym, direct, retNext));
  // Merge offers; the offers PK collapses a trip that both windows somehow returned (§dedup).
  const seen = new Set();
  const offers = [];
  for (const o of [...w1.offers, ...w2.offers]) {
    const k = `${o.flight_type}|${o.departure_at}|${o.return_at}`;
    if (seen.has(k)) continue;
    seen.add(k);
    offers.push(o);
  }
  const mins = [w1.min, w2.min].filter((v) => v != null);
  const min = mins.length ? Math.min(...mins) : null;
  const anyFail = !w1.ok || !w2.ok;
  if (min != null) return { ok: true, min, offers };
  if (!anyFail) return { ok: true, min: null, offers: [] };
  return { ok: false, min: null, offers: [] };
}

// CALENDAR source (§calendar): Travelpayouts v2 month-matrix — the cheapest ticket per departure
// day of a month, a SEPARATE data-access endpoint from the pointwise prices_for_dates above. Used
// ONLY as the last attempt on an empty cell (§attempt-order). RUNTIME-GUARDED: a transport failure,
// a non-success body, or a response with no usable price>0 all return ok:false, so an empty or
// unavailable calendar is ignored and never clobbers a known price. When it DOES carry content, the
// cell's type is the cheapest record's (0 changes → direct, else any) and only offers consistent
// with that type are kept, so selection and pruning stay single-typed like a normal probe.
async function fetchCalendarMonth(origin, dest, ym, paced) {
  const url =
    'https://api.travelpayouts.com/v2/prices/month-matrix' +
    `?currency=eur&origin=${origin}&destination=${dest}&month=${ym}-01&show_to_affiliates=true&token=${TP_TOKEN}`;
  const r = await paced(() => getJson(url));
  if (!r || r.success !== true || !Array.isArray(r.data)) return { ok: false, min: null, offers: [], type: null };
  const nowIso = new Date().toISOString();
  const parsed = [];
  for (const x of r.data) {
    const departure_at = toDateOnly(x.depart_date);
    const price = typeof x.value === 'number' ? Math.round(x.value) : NaN;
    if (!departure_at || !(price > 0)) continue;
    if (departure_at.slice(0, 7) !== ym) continue; // cell = departure month (§dedup)
    const transfers = Number.isFinite(x.number_of_changes) ? Math.trunc(x.number_of_changes) : 0;
    parsed.push({ departure_at, return_at: toDateOnly(x.return_date), price, transfers });
  }
  if (!parsed.length) return { ok: false, min: null, offers: [], type: null }; // no content → ignore (§calendar)
  const cheapest = parsed.reduce((a, b) => (b.price < a.price ? b : a));
  const type = cheapest.transfers === 0 ? 'direct' : 'any';
  // Keep only offers that fit the chosen column: 'direct' means non-stop only; 'any' takes all.
  const offers = parsed
    .filter((o) => (type === 'direct' ? o.transfers === 0 : true))
    .map((o) => ({
      origin, dest, month: ym, flight_type: type,
      departure_at: o.departure_at, return_at: o.return_at,
      nights: nightsBetween(o.departure_at, o.return_at),
      price: o.price, transfers: o.transfers, airline: null, updated_at: nowIso,
    }));
  const min = Math.min(...offers.map((o) => o.price));
  return { ok: true, min, offers, type };
}

// ONE paginated scan of `prices` that answers two questions at once:
//   • map   — the CURRENT price of every route-month, keyed `origin|dest|month`. The baseline
//             the run compares against so price_history only logs CHANGES.
//   • seen / alive — which route-PAIRS have any row inside the horizon at all, and which of
//             those have ever shown a non-null price there. Their difference is the dead list
//             (see planRoutes): ~33 000 rows read once, instead of a second scan of the same
//             table for the same bytes.
// PostgREST silently caps a .select() at 1000 rows (we hold ~33 000) — we page with .range()
// and a STABLE .order() over the primary key, because unordered pages can repeat or skip rows
// across the cap, silently and with no error.
async function loadPriceBaseline() {
  const map = new Map();
  const seen = new Set();   // pairs with at least one row inside the horizon
  const alive = new Set();  // pairs with at least one non-null price inside the horizon
  const PAGE = 1000;
  let from = 0;
  let rowsRead = 0;
  for (;;) {
    const res = await supabase
      .from('prices')
      .select('origin,dest,month,direct,any_stops')
      .order('origin', { ascending: true })
      .order('dest', { ascending: true })
      .order('month', { ascending: true })
      .range(from, from + PAGE - 1);
    const { data, error } = res;
    if (error) {
      // A read failure here would make EVERY route look "changed" and flood price_history —
      // and would also wipe the dead list, silently turning the skip off. Abort loudly, but
      // through describeError: this message ends up in the fatal handler, and a Cloudflare
      // HTML page there is just as unreadable as it is mid-run.
      throw new Error(`could not load existing prices (baseline): ${describeError(httpStatusOf(res, error), error)}`);
    }
    if (!data || data.length === 0) break;
    for (const r of data) {
      map.set(`${r.origin}|${r.dest}|${r.month}`, { direct: r.direct, any_stops: r.any_stops });
      // Deadness is judged over the CURRENT horizon only. A row for a month that has already
      // passed says nothing about whether the route flies in the months we are collecting.
      if (!HORIZON_MONTHS.has(r.month)) continue;
      const pair = `${r.origin}|${r.dest}`;
      seen.add(pair);
      if (r.direct != null || r.any_stops != null) alive.add(pair);
    }
    rowsRead += data.length;
    if (data.length < PAGE) break;
    from += PAGE;
  }
  return { map, seen, alive, rowsRead };
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

// ── Validating the CSV before it is uploaded ──────────────────────────────────
// The bucket accepting an object proves only that bytes arrived. It says nothing about whether
// those bytes are the snapshot we meant to keep, and a snapshot is read months later, by which
// time the run that produced it is unreproducible. So the CSV is checked while we still have
// the run that made it.
//
// The expected header is written out AGAIN here instead of being shared with the builder above.
// A shared constant would make this check tautological — it would compare the builder's header
// to itself and pass on any typo. Duplicated, it is a real assertion: change one and the other
// objects. The two literals must be edited together, and that is the point.
const SNAPSHOT_CSV_HEADER_EXPECTED = 'origin,dest,depart_month,price_direct,price_any,currency,fetched_at,scope';
const SNAPSHOT_CSV_FIELDS = SNAPSHOT_CSV_HEADER_EXPECTED.split(',').length; // 8
const SNAPSHOT_MONTH_COL = 2; // depart_month
const SNAPSHOT_SCOPE_COL = 7; // scope
// Marker for the log line, deliberately distinct from WRITE_LOSS_MARKER: this is a malformed
// artifact, not a lost write, and conflating the two greps would blur the difference.
const SNAPSHOT_INVALID_MARKER = 'SNAPSHOT-INVALID';
// How many offending rows/values a failure line names before it stops. A malformed snapshot can
// be malformed in all 4400 rows, and a log line that long is unreadable — the count is the
// number that matters, the samples only say where to look.
const SNAPSHOT_INVALID_SAMPLES = 5;

// `"value" ×n, "other" ×m` for a tally Map, capped at SNAPSHOT_INVALID_SAMPLES distinct values.
function formatValueTally(tally) {
  const parts = [...tally.entries()]
    .slice(0, SNAPSHOT_INVALID_SAMPLES)
    .map(([v, n]) => `"${v}" ×${n}`);
  if (tally.size > SNAPSHOT_INVALID_SAMPLES) parts.push(`… ${tally.size - SNAPSHOT_INVALID_SAMPLES} more distinct value(s)`);
  return parts.join(', ');
}

// Returns { valid, failures } — `failures` is one human-readable string per FAILED check, each
// carrying expected and actual numbers, and it doubles as the machine-readable list in the job's
// JSON artifact. Never throws for bad input: every check is written to survive a garbled CSV,
// because the whole reason we are here is that the CSV might be garbage. (The caller wraps the
// call anyway — a validator that threw would abort an upload that must happen regardless.)
function validateSnapshotCsv(csv, expectedRows, scope, months) {
  const failures = [];
  const lines = csv.split('\n');
  // Every row the builder emits ends in '\n', so the split leaves one trailing empty element.
  // Dropping exactly that one keeps the count honest; a MISSING trailing newline shows up as a
  // line-count mismatch rather than being silently forgiven.
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  // 1. Line count: header + one row per collected route-month.
  const expectedLines = expectedRows + 1;
  if (lines.length !== expectedLines) {
    failures.push(`line count: expected ${expectedLines} (1 header + ${expectedRows} data rows), got ${lines.length}`);
  }

  // 2. Header, verbatim.
  const header = lines.length > 0 ? lines[0] : '';
  if (header !== SNAPSHOT_CSV_HEADER_EXPECTED) {
    failures.push(`header: expected "${SNAPSHOT_CSV_HEADER_EXPECTED}", got "${header}"`);
  }

  // 3-5. Per-row checks. Counted in full, sampled in the message. Note that a row with the
  // wrong field count is ALSO checked for scope/month: its columns have shifted, so it will
  // usually trip those too, and seeing all three symptoms is more useful than suppressing two.
  const body = lines.slice(1);
  const allowedMonths = new Set(months);
  const badFields = [];
  let badFieldsTotal = 0;
  const wrongScope = new Map();
  const foreignMonths = new Map();
  const bump = (map, key) => map.set(key, (map.get(key) ?? 0) + 1);

  body.forEach((line, i) => {
    const f = line.split(',');
    if (f.length !== SNAPSHOT_CSV_FIELDS) {
      badFieldsTotal += 1;
      // i is 0-based over the body, so the line number in the file is i + 2.
      if (badFields.length < SNAPSHOT_INVALID_SAMPLES) badFields.push(`line ${i + 2} has ${f.length}`);
    }
    const rowScope = f[SNAPSHOT_SCOPE_COL];
    if (rowScope !== scope) bump(wrongScope, rowScope ?? '');
    const rowMonth = f[SNAPSHOT_MONTH_COL];
    if (!allowedMonths.has(rowMonth)) bump(foreignMonths, rowMonth ?? '');
  });

  if (badFieldsTotal > 0) {
    const more = badFieldsTotal > badFields.length ? `, … ${badFieldsTotal - badFields.length} more` : '';
    failures.push(`field count: expected ${SNAPSHOT_CSV_FIELDS} in every one of ${body.length} data rows, got ${badFieldsTotal} row(s) with another count (${badFields.join(', ')}${more})`);
  }
  if (wrongScope.size > 0) {
    const rows = [...wrongScope.values()].reduce((a, b) => a + b, 0);
    failures.push(`scope column: expected "${scope}" in all ${body.length} data rows, got ${rows} row(s) with another value (${formatValueTally(wrongScope)})`);
  }
  if (foreignMonths.size > 0) {
    const rows = [...foreignMonths.values()].reduce((a, b) => a + b, 0);
    failures.push(`depart_month: expected only the ${months.length} month(s) this job collected [${months.join(', ')}], got ${rows} row(s) with a foreign month (${formatValueTally(foreignMonths)})`);
  }

  return { valid: failures.length === 0, failures };
}

// The marker leads EVERY line, including the enumeration, so `grep SNAPSHOT-INVALID` returns the
// whole verdict and not just its first line.
function logSnapshotInvalid(scope, failures) {
  console.warn(`${SNAPSHOT_INVALID_MARKER} scope ${scope}: ${failures.length} check(s) failed — the object is uploaded anyway, under its normal key, for post-mortem.`);
  failures.forEach((f, i) => console.warn(`${SNAPSHOT_INVALID_MARKER}   [${i + 1}/${failures.length}] ${f}`));
}

// ── The job's machine-readable trace ─────────────────────────────────────────
// One small JSON per job, picked up by actions/upload-artifact and read by the watchdog job at
// the end of the sweep. The scope is in the FILENAME as well as the body: the four jobs run on
// four separate runners but the watchdog merges their artifacts into one directory, where a
// fixed name would have three of the four overwrite each other.
//
// Shape: { scope, rows, valid, uploaded, failures }.
//
// WRITTEN TWICE, and the order matters. The first write goes out BEFORE the upload is attempted,
// with `uploaded: null` — so a job that dies on Storage still leaves a trace, which is the whole
// reason the trace exists. The second write replaces it once Storage has answered, carrying
// `uploaded: true|false` taken from that answer.
//
// A file left at `uploaded: null` is therefore a real outcome and not an oversight: it says the
// job did not live to hear back. The watchdog treats null exactly like false — anything that is
// not a definite `true` reds the run. Bucket not found in July went unnoticed for four days
// precisely because "we never found out" and "it worked" looked the same from outside.
const SNAPSHOT_REPORT_PATH = `snapshot-report-${SCOPE}.json`;
let snapshotReportWritten = false;
function writeSnapshotReport(report) {
  try {
    writeFileSync(SNAPSHOT_REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    snapshotReportWritten = true;
  } catch (e) {
    // Same contract as everything else in this block: the trace is diagnostics, and diagnostics
    // never fail the ETL. A missing artifact is what the watchdog reports on.
    console.warn(`⚠ could not write ${SNAPSHOT_REPORT_PATH} (non-fatal, ETL unaffected): ${e?.message ?? e}`);
  }
}

async function uploadSnapshot(rows, scope) {
  let gz = null;
  // Declared out here so the catch below can still report a verdict for a run that threw before
  // the CSV was even validated.
  let validation = null;
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
    // Validate, then upload NO MATTER WHAT the verdict is, under the unchanged key. A snapshot
    // that fails a check is the one you most want to look at, and refusing to store it — or
    // filing it under some `-invalid` name — destroys the evidence and breaks the naming the
    // reader relies on. The verdict travels in the log, the WRITE-LOSS line and the artifact.
    // Wrapped: a bug in the validator must not take the upload down with it, so a throw here
    // becomes an invalid verdict rather than an exception.
    try {
      validation = validateSnapshotCsv(csv, rows.length, scope, MONTHS);
    } catch (e) {
      validation = { valid: false, failures: [`validator itself threw: ${e?.message ?? e}`] };
    }
    if (!validation.valid) logSnapshotInvalid(scope, validation.failures);
    // Rides on the storage_snapshot line of the existing WRITE-LOSS summary. Set in BOTH
    // directions on purpose: an explicit "valid" is evidence, a missing note is only silence.
    noteWriteLoss('storage_snapshot', validation.valid
      ? 'csv valid'
      : `csv ${SNAPSHOT_INVALID_MARKER} (${validation.failures.length} check(s) failed)`);
    // Phase one of the trace: written BEFORE gzip and before the upload, so a job that dies on
    // Storage still leaves one. `uploaded: null` = Storage has not answered yet; main() replaces
    // this file with the verdict once it has.
    writeSnapshotReport({ scope, rows: rows.length, valid: validation.valid, uploaded: null, failures: validation.failures });

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
    const r = await writeWithRetry(`snapshot upload ${key}`, () => supabase.storage
      .from(SNAPSHOT_BUCKET)
      .upload(key, gz, { contentType: 'application/gzip', upsert: true }),
    { target: 'storage_snapshot', rows: rows.length });
    if (!r.ok) {
      console.warn(`⚠ snapshot upload failed after ${r.attempts} attempt(s) (non-fatal, ETL unaffected): ${r.why}`);
      return { ok: false, key, kb, rows: rows.length, error: r.why, attempts: r.attempts, valid: validation.valid, failures: validation.failures };
    }
    return { ok: true, key, kb, rows: rows.length, error: null, attempts: r.attempts, valid: validation.valid, failures: validation.failures };
  } catch (e) {
    const why = describeError(httpStatusOf(null, e), e);
    // Threw OUTSIDE writeWithRetry (building the CSV, gzipping, the timestamp) — so nothing
    // recorded it. Permanent: no request was made, and repeating it would throw again.
    recordWriteLoss('storage_snapshot', 'permanent', rows.length);
    console.warn(`⚠ snapshot upload failed (non-fatal, ETL unaffected): ${why}`);
    // A throw before/at gzip means no verdict was reached. Report that as invalid rather than
    // leaving the artifact absent: "we do not know" and "the watchdog saw nothing" look the
    // same from the outside, and only one of them is true here.
    if (!validation) {
      validation = { valid: false, failures: [`snapshot never validated — threw before the check: ${why}`] };
      noteWriteLoss('storage_snapshot', `csv ${SNAPSHOT_INVALID_MARKER} (never validated)`);
      logSnapshotInvalid(scope, validation.failures);
    }
    // Threw before phase one ran (the timestamp, the CSV, gzip). No request was made, so nothing
    // was uploaded and we know it — `false`, not `null`. main() overwrites this with the same
    // verdict plus the reason; this write only guarantees a trace exists from here on.
    if (!snapshotReportWritten) {
      writeSnapshotReport({ scope, rows: rows.length, valid: validation.valid, uploaded: false, failures: validation.failures });
    }
    return { ok: false, key: null, kb: gz ? (gz.length / 1024).toFixed(1) : null, rows: rows.length, error: why, valid: validation.valid, failures: validation.failures };
  }
}

// Build the day's route list from the catalog and what the database already knows.
//
// SKIPPING THE DEAD. A large share of the pairs have no price in ANY month of the horizon —
// airport combinations nobody flies — and asking about them spends the run for nothing. They
// are not dropped, though: routes DO open, and a pair that is never asked can never be seen to
// open. Each run re-checks 1/7 of the dead list, so the whole list is covered every week.
//
// WHICH seventh is decided by the run's day number, not at random and not by "what we checked
// last time" — the dead pairs are sorted into a stable order and sliced by index % 7, and the
// day number picks the slice. Consecutive days therefore take consecutive, disjoint slices:
// no pair is checked twice in a week and none is missed.
//
// A pair with NO rows at all inside the horizon is treated as live, never as dead. That is a
// pair we have no evidence about (a new destination, a new origin), and the failure direction
// matters: calling an unknown pair dead would hide it for a week at a time.
function planRoutes(seen, alive) {
  const live = [];
  const dead = [];
  for (const origin of ORIGINS_ALL) {
    for (const dest of targetsFor(origin)) {
      const key = `${origin}|${dest}`;
      if (seen.has(key) && !alive.has(key)) dead.push({ origin, dest, key });
      else live.push({ origin, dest, key });
    }
  }
  dead.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)); // stable slicing order
  const slice = ((PLAN_DAY % DEAD_SLICES) + DEAD_SLICES) % DEAD_SLICES;
  const probed = dead.filter((_, i) => i % DEAD_SLICES === slice);
  return { live, dead, probed, slice };
}

async function main() {
  console.log(`Supabase: ${SUPABASE_URL}`);
  console.log(`Supabase key role: ${SERVICE_KEY_ROLE}`);
  console.log(`Origins (${ORIGINS_ALL.length}, all query the full ${DEST_IATAS.length}-destination network): ${ORIGINS_ALL.join(', ')}`);
  console.log(`  hubs (${HUB_AIRPORTS.length}): ${HUB_AIRPORTS.join(', ')}`);
  console.log(`  low-cost bases (${LOWCOST_AIRPORTS.length}): ${LOWCOST_AIRPORTS.join(', ')}`);
  console.log(`Flight months (${MONTHS.length}): ${MONTHS[0]} … ${MONTHS[MONTHS.length - 1]}  (MONTH_START=${MONTH_START}, MONTH_COUNT=${MONTH_COUNT})`);

  // Start-of-run timestamp. Rows written this run get updated_at >= this; stale-offer
  // pruning deletes only rows OLDER than it, so a fresh row is never removed.
  const RUN_START_ISO = new Date().toISOString();

  // Baseline: the current price of every route-month, loaded ONCE (paginated) BEFORE the plan
  // is built — it feeds both change detection and the dead-pair list.
  const { map: existingPrices, seen, alive, rowsRead } = await loadPriceBaseline();
  console.log(`Loaded ${rowsRead} existing price rows (baseline for change detection; ${existingPrices.size} route-months)`);

  // Plan the run so we can print totals and a live ETA.
  //
  // ORDER IS SHUFFLED, deterministically, with the day number as the seed. The plan used to
  // be walked in catalog order, so anything that cut a run short — a timeout, a cancellation,
  // a 502 burst — always cost the SAME airports, the ones sitting in the tail (DRS, LEJ went
  // uncollected repeatedly). Shuffling spreads that damage over the whole network instead of
  // concentrating it, while the seed keeps the run replayable: same date, same order.
  const { live, dead, probed, slice } = planRoutes(seen, alive);
  const deadProbed = new Set(probed.map((r) => r.key));
  // Full deterministic plan (same seed as always). Manual sampling is applied to THIS shuffled
  // order — a prefix of a uniform shuffle is itself a uniform random subset — so a capped or
  // fractional run measures the same spread the nightly would, never the head of the catalog.
  const plannedRoutes = shuffledBySeed([...live, ...probed], PLAN_DAY);
  let routes = plannedRoutes;
  if (SAMPLE_FRACTION < 1) {
    routes = routes.slice(0, Math.max(1, Math.ceil(routes.length * SAMPLE_FRACTION)));
  }
  if (MAX_ROUTES > 0 && routes.length > MAX_ROUTES) {
    routes = routes.slice(0, MAX_ROUTES);
  }
  if (routes.length !== plannedRoutes.length) {
    console.log(`Manual sampling ACTIVE: ${routes.length} of ${plannedRoutes.length} planned pairs`
      + `${SAMPLE_FRACTION < 1 ? ` · sample=${SAMPLE_FRACTION}` : ''}`
      + `${MAX_ROUTES > 0 ? ` · max_routes=${MAX_ROUTES}` : ''} — this is a manual run, the nightly is unaffected`);
  }
  const routeTotal = routes.length;
  const catalogTotal = live.length + dead.length;
  // Baseline requests = TWO per cell (the two return windows, §edge-months). Empty cells add up to
  // three more (alt-type ×2 + calendar ×1); those are NOT in this estimate — they show up as
  // `extraRequests` in the summary. ETA uses the baseline, so it reads a little short on a run with
  // many empty cells. §load: shrink the run by MONTH_COUNT, never by dropping attempts.
  const totalRequests = routeTotal * MONTHS.length * 2; // two return windows per route-month

  console.log(`Route plan: ${live.length} live + ${probed.length} of ${dead.length} dead (slice ${slice + 1}/${DEAD_SLICES}, whole list every ${DEAD_SLICES} days) = ${routeTotal} of ${catalogTotal} pairs`);
  console.log(`Flight requests: ${totalRequests} baseline (2 return windows × ${routeTotal} pairs × ${MONTHS.length} months); empty cells add up to 3 more each`);
  console.log(`At ${TARGET_INTERVAL_MS}ms/request (${(60000 / TARGET_INTERVAL_MS).toFixed(1)} req/min) ≈ ${Math.round(totalRequests * TARGET_INTERVAL_MS / 60000)} min baseline\n`);

  // Batches that exhausted every retry and are gone for good. Row counts live in the
  // per-table *WriteErrors counters; this counts the LOSSES, so the summary can state the
  // damage in one line instead of leaving it as a warning somewhere in the middle of the log.
  const lostBatches = { prices: 0, offers: 0, history: 0 };

  // Supabase write buffer + counters. We flush in BATCH-sized upserts, and flush
  // periodically during the (multi-hour) run so partial progress is persisted.
  const priceBuf = [];
  const snapshotRows = []; // TEE of this run's collected price rows → gzip-CSV history file
  let pricesWritten = 0;
  let priceWriteErrors = 0;

  async function flushPrices(force = false) {
    while (priceBuf.length >= BATCH || (force && priceBuf.length > 0)) {
      const rows = priceBuf.splice(0, BATCH);
      const r = await writeWithRetry(`prices upsert (${rows.length} rows)`, () =>
        supabase.from('prices').upsert(rows, { onConflict: 'origin,dest,month' }),
      { target: 'prices', rows: rows.length });
      if (r.ok) pricesWritten += rows.length;
      else {
        console.warn(`    ⚠ prices upsert LOST ${rows.length} rows after ${r.attempts} attempt(s) — ${r.why}`);
        priceWriteErrors += rows.length;
        lostBatches.prices += 1;
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
      const r = await writeWithRetry(`price_history insert (${rows.length} rows)`, () =>
        supabase.from('price_history').insert(rows),
      { target: 'price_history', rows: rows.length });
      if (r.ok) historyWritten += rows.length;
      else {
        console.warn(`    ⚠ price_history insert LOST ${rows.length} rows after ${r.attempts} attempt(s) — ${r.why}`);
        historyWriteErrors += rows.length;
        lostBatches.history += 1;
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
      const r = await writeWithRetry(`offers upsert (${rows.length} rows)`, () => supabase
        .from('offers')
        .upsert(rows, { onConflict: 'origin,dest,month,flight_type,departure_at,return_at' }),
      { target: 'offers', rows: rows.length });
      if (r.ok) offersWritten += rows.length;
      else {
        console.warn(`    ⚠ offers upsert LOST ${rows.length} rows after ${r.attempts} attempt(s) — ${r.why}`);
        offerWriteErrors += rows.length;
        lostBatches.offers += 1;
      }
    }
  }

  // Prune offers for one route (its successfully-fetched months only) that are OLDER than
  // this run — i.e. offers the API no longer returns. Scoped to `months` (via .in) so a
  // month whose request FAILED this run keeps its previous offers instead of being wiped.
  // .select() returns the deleted rows so we can count them.
  async function pruneStaleOffers(origin, dest, flightType, months) {
    const r = await writeWithRetry(`offers prune ${origin}→${dest}`, () => supabase
      .from('offers')
      .delete()
      .eq('origin', origin)
      .eq('dest', dest)
      .eq('flight_type', flightType)
      .in('month', months)
      .lt('updated_at', RUN_START_ISO)
      .select('origin'),
    // rows: null — how many stale rows this DELETE would have removed is only known from
    // its own .select(), which is exactly what we did not get back.
    { target: 'offers_prune', rows: null });
    if (r.ok) offersDeleted += (r.data?.length ?? 0);
    else {
      console.warn(`    ⚠ offers prune FAILED ${origin}→${dest} after ${r.attempts} attempt(s) — ${r.why}`);
      offerDeleteErrors += 1;
    }
  }

  let withPrice = 0;  // routes that got at least one price
  let noData = 0;     // routes with no price at all
  let reqDone = 0;
  let reqFailed = 0;  // cells where every attempt failed → nothing written, old value kept
  let deadRevived = 0; // dead pairs re-checked this run that came back with a price
  let route = 0;
  // Fallback bookkeeping (§attempt-order/§load), reported at the end. `extraRequests` counts ONLY
  // the additional TP calls spent on empty cells (the alt-type probe and the calendar); the two
  // natural-window calls every cell makes are NOT counted here. `cellsClosedByAlt` / `…Calendar`
  // are empty cells that a fallback filled with a real price.
  let extraRequests = 0;
  let cellsClosedByAlt = 0;
  let cellsClosedByCalendar = 0;
  // Pacing metrics for the summary: how fast we ACTUALLY went, and how often the API itself
  // was slower than the interval (those requests set the pace, we can't sleep negative time).
  let reqOverInterval = 0;
  let reqMsTotal = 0;
  const t0 = Date.now();
  const paceT0 = Date.now(); // start of the collection window, for the achieved req/min
  const etaMin = () => Math.round((totalRequests - reqDone) * TARGET_INTERVAL_MS / 60000);

  // Run ONE TP request under the shared pace: time it, count it, then sleep the REMAINDER of
  // TARGET_INTERVAL_MS so the spacing between request STARTS is constant no matter how many
  // requests a cell makes (two windows, plus any fallbacks). Same rule the old single-request
  // loop used, hoisted so every probe helper obeys it. `fn` returns the request's own result.
  const pacedCall = async (fn) => {
    const reqT0 = Date.now();
    const out = await fn();
    const reqMs = Date.now() - reqT0;
    reqDone += 1;
    reqMsTotal += reqMs;
    const remaining = TARGET_INTERVAL_MS - reqMs;
    if (remaining > 0) await sleep(remaining);
    else reqOverInterval += 1;
    return out;
  };

  for (const { origin, dest } of routes) {
    route += 1;
    const stops = STOPS[dest];
    const flightHasStop = stops === 1;    // long-haul default: cheapest 1+ stop
    const naturalDirect = !flightHasStop; // near = direct, far = any
    const byMonth = {};
    let okCells = 0; // cells with an ok response this run (priced or genuine-empty)
    // Months for which we got an ok response PER TYPE — pruning covers exactly the (type, month)
    // cells this run actually confirmed: a fallback of the OTHER type is pruned under its own type,
    // and a fully-empty cell (both types answered empty) prunes BOTH, so no stale row of either type
    // lingers behind a now-empty cell.
    const prunable = { direct: [], any: [] };
    for (const ym of MONTHS) {
      const retNext = nextMonthYM(ym);
      const naturalType = naturalDirect ? 'direct' : 'any';
      const answered = new Set(); // flight types that returned an ok response for THIS cell
      // Attempt 1 (§attempt-order): the cell's NATURAL type over BOTH return windows (§edge-months).
      let res = await probeType(origin, dest, ym, retNext, naturalDirect, pacedCall);
      if (res.ok) answered.add(naturalType);
      let usedType = naturalType;
      // §load: extra attempts fire ONLY on a genuinely EMPTY cell (ok:true, no price) — never on a
      // failed one (ok:false keeps its previous value, §first-edit). Order: alt stop-type, then the
      // calendar; we stop at the first that returns a price.
      if (res.ok && res.min == null) {
        const altType = naturalDirect ? 'any' : 'direct';
        const alt = await probeType(origin, dest, ym, retNext, !naturalDirect, pacedCall);
        extraRequests += 2;
        if (alt.ok) answered.add(altType);
        if (alt.ok && alt.min != null) {
          res = alt;
          usedType = altType;
          cellsClosedByAlt += 1;
        } else if (res.ok && res.min == null) {
          const cal = await fetchCalendarMonth(origin, dest, ym, pacedCall);
          extraRequests += 1;
          if (cal.ok && cal.min != null) {
            answered.add(cal.type);
            res = { ok: true, min: cal.min, offers: cal.offers };
            usedType = cal.type;
            cellsClosedByCalendar += 1;
          }
        }
      }

      // EVERY buffer write below sits inside `if (ok)` ON PURPOSE — see fetch-prices.test.cjs. A
      // cell is written only when an attempt SUCCEEDED (ok:true), whether it found a price or a
      // genuine "no flights" (min:null — a real observation, written to unfreeze a disappeared
      // price). An INCONCLUSIVE cell (every attempt failed) is ok:false: it writes nothing and
      // keeps the previous value, so an empty/failed attempt never clobbers a known price (§first-edit).
      const ok = res.ok;
      if (ok) {
        okRouteMonths += 1;
        okCells += 1;
        const pair = usedType === 'direct' ? { direct: res.min, any: null } : { direct: null, any: res.min };
        byMonth[ym] = pair;
        // One prices row per route-month → upsert on PK (origin,dest,month).
        priceBuf.push({ origin, dest, month: ym, direct: pair.direct, any_stops: pair.any, updated_at: new Date().toISOString() });
        // Tee (observe only) the same values for the history snapshot — no effect on collection/write.
        snapshotRows.push({ origin, dest, month: ym, direct: pair.direct, any: pair.any, fetched_at: RUN_START_ISO });

        // price_history: log ONLY when this price differs from the baseline (or the route is new).
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

        // COMBO selection → the offers buffer (cheap pool + one per distance target).
        const combo = selectCombo(res.offers, origin, dest);
        for (const o of combo) offerBuf.push(o);
        offersCollected += combo.length;
      } else {
        // Every attempt for this cell failed → nothing written, previous value kept.
        reqFailed += 1;
      }
      // Prune-eligibility: every type that answered this cell (empty or priced). Outside the write
      // guard on purpose — it drives DELETE scoping, not a Supabase write buffer.
      for (const tp of answered) prunable[tp].push(ym);
    }
    await flushPrices(false);
    await flushHistory(false);

    // Force-flush THIS route's offers before pruning stale ones, and prune PER flight_type over the
    // months that answered for that type — a cell filled by a fallback of the other type is pruned
    // under its own type, a fully-empty cell prunes both, and a fresh row (updated_at ≥ run start)
    // is never deleted.
    const offerErrBefore = offerWriteErrors;
    await flushOffers(true);
    if (offerWriteErrors === offerErrBefore) {
      for (const ftype of ['direct', 'any']) {
        if (prunable[ftype].length) await pruneStaleOffers(origin, dest, ftype, prunable[ftype]);
      }
    }

    const okMonthsCount = okCells;
    const got = Object.values(byMonth).some((p) => p.direct != null || p.any != null);
    if (got) withPrice += 1; else noData += 1;
    // A pair from the dead slice that answered with a price is back in service — it rejoins the
    // live list on the next run automatically, since the list is derived from `prices`.
    const wasDead = deadProbed.has(`${origin}|${dest}`);
    if (wasDead && got) deadRevived += 1;
    const vals = Object.values(byMonth).map((p) => (p.direct != null ? p.direct : p.any)).filter((p) => p != null);
    const min = vals.length ? `€${Math.min(...vals)}` : '—';
    // byMonth only holds ANSWERED cells, so a gap here means every attempt failed for those —
    // surfaced per route so a bad patch is visible while the run is still going.
    const failedHere = MONTHS.length - okMonthsCount;
    const failMark = failedHere ? `  ⚠ ${failedHere}/${MONTHS.length} cell(s) failed, kept previous` : '';
    const deadMark = wasDead ? (got ? '  ⟲ dead pair REVIVED' : '  (dead re-check)') : '';
    console.log(`[route ${route}/${routeTotal}] ${origin}→${dest}: ${min}${failMark}${deadMark}   ~${etaMin()}m left`);
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
  console.log(`TP requests: ${reqDone} made (${totalRequests} baseline two-window + ${extraRequests} extra on empty cells)`);
  console.log(`Origins: ${ORIGINS_ALL.length} (${HUB_AIRPORTS.length} hubs + ${LOWCOST_AIRPORTS.length} low-cost)`);
  console.log(`Destinations: ${DEST_IATAS.length}  ·  Route-pairs: ${routeTotal}  ·  Months: ${MONTHS.length}  ·  cells: ${routeTotal * MONTHS.length}`);
  console.log(`Route plan: ${live.length} live  ·  ${dead.length} dead, of which ${probed.length} re-checked (slice ${slice + 1}/${DEAD_SLICES})  ·  ${catalogTotal - routeTotal} pairs skipped this run`);
  console.log(`Dead pairs revived this run: ${deadRevived} of ${probed.length} re-checked`);
  console.log(`Routes with a price: ${withPrice}  ·  no data: ${noData}`);
  console.log(`Failed cells: ${reqFailed} of ${routeTotal * MONTHS.length} — every attempt failed, nothing written, previous values kept`);
  console.log(`Fallback on empty cells: ${extraRequests} extra requests  ·  closed ${cellsClosedByAlt} by alt stop-type + ${cellsClosedByCalendar} by calendar = ${cellsClosedByAlt + cellsClosedByCalendar}`);
  console.log(`Pace: target ${TARGET_INTERVAL_MS}ms (${(60000 / TARGET_INTERVAL_MS).toFixed(1)} req/min)  ·  achieved ${achievedRpm} req/min over ${paceMin.toFixed(1)} min  ·  avg request ${avgReqMs}ms`);
  console.log(`  requests slower than the interval: ${reqOverInterval} (those set the pace themselves — nothing left to sleep off)`);
  console.log(`Supabase prices: ${pricesWritten} rows written, ${priceWriteErrors} errors`);
  console.log(`Price changes: ${pricesChanged} changed/new  ·  ${pricesUnchanged} unchanged (baseline ${existingPrices.size})`);
  console.log(`Supabase price_history: ${historyWritten} rows written, ${historyWriteErrors} errors`);
  console.log(`Supabase offers: ${offersWritten} rows written, ${offerWriteErrors} errors`);
  console.log(`  offers collected: ${offersCollected}  ·  avg per route-month: ${avgOffers} (over ${okRouteMonths} answered route-months)`);
  console.log(`  stale offers pruned: ${offersDeleted}  ·  prune errors: ${offerDeleteErrors}`);
  const lostTotal = lostBatches.prices + lostBatches.offers + lostBatches.history;
  const lostRows = priceWriteErrors + offerWriteErrors + historyWriteErrors;
  console.log(lostTotal
    ? `Write failures: ${lostTotal} batches lost (prices ${lostBatches.prices}, offers ${lostBatches.offers}, history ${lostBatches.history}) — ${lostRows} rows never written, after ${WRITE_MAX_ATTEMPTS} attempts each`
    : `Write failures: 0 batches lost (prices 0, offers 0, history 0)`);
  console.log(snapshot.ok
    ? `Snapshot upload: OK → ${SNAPSHOT_BUCKET}/${snapshot.key}  (${snapshot.rows} rows, ${snapshot.kb} KB gz)`
    : `Snapshot upload: FAILED — ${snapshot.error}  (${snapshot.rows} rows${snapshot.kb ? `, ${snapshot.kb} KB gz` : ''} NOT uploaded)`);
  // Phase two of the trace, deliberately right here, off the SAME `snapshot.ok` the line above
  // prints. That value came out of writeWithRetry as `r.ok`, so the log, the artifact and the
  // watchdog all read one answer from one place; asking Storage a second time would be a second
  // truth that could disagree with the first. The reason travels with it, so the watchdog prints
  // "HTTP 400: Bucket not found" in DETAIL rather than a bare FAILED.
  writeSnapshotReport({
    scope: SCOPE,
    rows: snapshot.rows,
    valid: snapshot.valid,
    uploaded: snapshot.ok,
    failures: snapshot.ok ? snapshot.failures : [...snapshot.failures, `upload failed: ${snapshot.error}`],
  });
  console.log(`Elapsed: ${elapsedMin} min`);
  // Last thing in the log, after everything else has had its say.
  logWriteLossSummary();
}

main().catch((e) => {
  console.error('Fatal error:', e);
  // A job that died before uploadSnapshot ran has no artifact at all, and the watchdog cannot
  // tell that apart from an upload-artifact step that silently did nothing. Leave the trace
  // here so every job that got as far as starting node is accounted for. writeFileSync is
  // synchronous, so it completes before the process.exit below.
  if (!snapshotReportWritten) {
    writeSnapshotReport({ scope: SCOPE, rows: 0, valid: false, uploaded: false, failures: ['job died before the snapshot was built'] });
  }
  // Printed on the way out too: a job that died mid-run has lost writes worth seeing, and
  // "always present" is what makes the marker greppable across every job in the sweep.
  // Exit code is untouched — this handler still fails the job exactly as before.
  logWriteLossSummary();
  process.exit(1);
});
