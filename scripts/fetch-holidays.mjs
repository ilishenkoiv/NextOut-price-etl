// scripts/fetch-holidays.mjs — yearly refresh of the public-holiday calendar for DE/AT/CH.
//
// Pulls holidays from OpenHolidaysAPI for the next two years and writes them to the
// `public_holidays` table (migration 20260802120000_public_holidays.sql). Runs once a year via
// .github/workflows/refresh-holidays.yml, and by hand:
//   PowerShell:  $env:SUPABASE_SERVICE_KEY="..."; node scripts/fetch-holidays.mjs
//   bash:        SUPABASE_SERVICE_KEY=... node scripts/fetch-holidays.mjs
//   npm:         npm run fetch-holidays        (SUPABASE_SERVICE_KEY must be in the env)
//
// ENV:
//   SUPABASE_SERVICE_KEY — Supabase service-role key, writes past RLS (required, SECRET).
//   SUPABASE_URL         — project URL (public, NOT a secret; default below).
//   YEARS_AHEAD          — how many years forward to fetch (default 2).
//
// ─────────────────────────────────────────────────────────────────────────────────────────────
// DATA SOURCE / ATTRIBUTION — REQUIRED BY LICENCE (ODbL v1.0):
//   Holiday data from OpenHolidaysAPI (https://www.openholidaysapi.org), © its contributors,
//   licensed under the Open Database License (ODbL) v1.0. Commercial use permitted; attribution
//   required. The same line must ALSO be shown in the app's "About" screen.
// ─────────────────────────────────────────────────────────────────────────────────────────────

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const ATTRIBUTION =
  'Holiday data © OpenHolidaysAPI contributors, licensed under the Open Database License (ODbL) v1.0 — https://www.openholidaysapi.org';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xpalogebawoljlafsafs.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const YEARS_AHEAD = Number(process.env.YEARS_AHEAD) || 2;

const COUNTRIES = ['DE', 'AT', 'CH'];
const API_BASE = 'https://openholidaysapi.org';
const INSERT_CHUNK = 500;

if (!SUPABASE_SERVICE_KEY) {
  console.error('Missing required secret:');
  console.error('  • SUPABASE_SERVICE_KEY (Supabase service-role key) is not set.');
  console.error('  PowerShell:  $env:SUPABASE_SERVICE_KEY="..."; node scripts/fetch-holidays.mjs');
  console.error('  bash:        SUPABASE_SERVICE_KEY=... node scripts/fetch-holidays.mjs');
  process.exit(1);
}

// Confirm the key is service_role (an anon key would be denied by RLS on write).
function keyRole(key) {
  try {
    const seg = key.split('.')[1];
    if (!seg) return '(opaque non-JWT key)';
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')).role || '(no role claim)';
  } catch {
    return '(unreadable)';
  }
}
if (keyRole(SUPABASE_SERVICE_KEY) !== 'service_role') {
  console.warn(`WARNING: SUPABASE_SERVICE_KEY role = "${keyRole(SUPABASE_SERVICE_KEY)}" (expected "service_role") — writes will likely be denied.`);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket }, // supabase-js builds a RealtimeClient at createClient (never connected)
});

// ── Date window: today .. today + YEARS_AHEAD years ──────────────────────────
function ymd(d) {
  return d.toISOString().slice(0, 10);
}
const today = new Date();
const VALID_FROM = ymd(today);
const validTo = new Date(today);
validTo.setUTCFullYear(validTo.getUTCFullYear() + YEARS_AHEAD);
const VALID_TO = ymd(validTo);

// ── Row shaping ──────────────────────────────────────────────────────────────
function levelOf(code) {
  if (!code) return 'country';
  // 'DE-BY' → 2 segments (state); 'DE-BY-AU' / 'CH-FR-LA-RI' → 3+ (a part of a state/canton).
  return code.split('-').length >= 3 ? 'district' : 'state';
}
function nameIn(names, lang) {
  const hit = (names || []).find((n) => n.language === lang);
  return hit ? hit.text : null;
}
// A public holiday can (rarely) span more than one day; emit one row per calendar day.
function datesInRange(startDate, endDate) {
  const out = [];
  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${(endDate || startDate)}T00:00:00Z`);
  for (let d = start; d <= end; d.setUTCDate(d.getUTCDate() + 1)) out.push(ymd(d));
  return out;
}

async function fetchCountry(country) {
  const url =
    `${API_BASE}/PublicHolidays?countryIsoCode=${country}` +
    `&validFrom=${VALID_FROM}&validTo=${VALID_TO}`; // no languageIsoCode → name[] has DE and EN
  const res = await fetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`OpenHolidaysAPI ${country}: HTTP ${res.status} ${res.statusText}`);
  return res.json();
}

function rowsFor(country, holidays) {
  const rows = [];
  for (const h of holidays) {
    const name_de = nameIn(h.name, 'DE');
    const name_en = nameIn(h.name, 'EN');
    if (!name_de || !name_en) {
      console.warn(`  ⚠ ${country} ${h.startDate} "${nameIn(h.name, 'EN') || '?'}": missing DE or EN name — skipped`);
      continue;
    }
    const scope = h.regionalScope || (h.nationwide ? 'National' : 'Regional');
    const base = { source_id: h.id ?? null, country, name_de, name_en, scope, type: h.type || 'Public' };

    for (const date of datesInRange(h.startDate, h.endDate)) {
      if (h.nationwide) {
        // One row per country — do NOT explode nationwide holidays across states. Force
        // scope='National': the source is inconsistent here (DE/CH tag nationwide holidays
        // "Regional", AT tags them "National"), but the `nationwide` flag is authoritative.
        rows.push({ ...base, scope: 'National', date, subdivision_code: null, level: 'country', partial: false });
      } else {
        const subs = h.subdivisions || [];
        if (subs.length === 0) {
          console.warn(`  ⚠ ${country} ${date} "${name_en}": non-nationwide with no subdivisions — skipped`);
          continue;
        }
        for (const sub of subs) {
          const code = sub.code;
          const level = levelOf(code);
          rows.push({
            ...base,
            date,
            subdivision_code: code,
            level,
            partial: level === 'district' || scope === 'Local',
          });
        }
      }
    }
  }
  return rows;
}

// Fold NULL subdivision to '' so nationwide rows dedupe the same way the DB's unique index does.
function dedupe(rows) {
  const seen = new Set();
  const out = [];
  for (const r of rows) {
    const k = `${r.country}|${r.subdivision_code ?? ''}|${r.date}|${r.name_en}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

async function main() {
  console.log(`Holiday refresh — ${VALID_FROM} … ${VALID_TO} (${YEARS_AHEAD}y ahead), countries: ${COUNTRIES.join(', ')}`);
  console.log(ATTRIBUTION);

  // 1) Fetch everything FIRST (so a fetch failure never leaves the table half-deleted).
  const all = [];
  for (const c of COUNTRIES) {
    const holidays = await fetchCountry(c);
    const rows = rowsFor(c, holidays);
    console.log(`  ${c}: ${holidays.length} holidays → ${rows.length} rows`);
    all.push(...rows);
  }
  const rows = dedupe(all);
  console.log(`Total rows to write: ${rows.length} (after dedupe)`);
  if (rows.length === 0) {
    console.error('Refusing to wipe the table: fetch returned zero rows.');
    process.exit(1);
  }

  // 2) Replace the window: delete existing future rows for these countries, then insert fresh.
  const del = await supabase
    .from('public_holidays')
    .delete()
    .in('country', COUNTRIES)
    .gte('date', VALID_FROM)
    .lte('date', VALID_TO);
  if (del.error) {
    console.error(`Delete failed: ${del.error.message}`);
    process.exit(1);
  }

  // 3) Insert in chunks.
  let written = 0;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    const ins = await supabase.from('public_holidays').insert(chunk);
    if (ins.error) {
      console.error(`Insert failed at rows ${i}..${i + chunk.length - 1}: ${ins.error.message}`);
      console.error('⚠ The table may be partially refreshed — re-run this job to restore it.');
      process.exit(1);
    }
    written += chunk.length;
  }

  console.log(`Done: ${written} rows written to public_holidays.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
