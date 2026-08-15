// scripts/cleanup-window-prices.mjs — daily cleanup of the carousel window-price table.
//
// Deletes rows from public.window_prices whose DEPARTURE has already passed — the window is over,
// its fare can never be shown again. "Passed" = departure_at strictly before today (Europe/Berlin,
// the same anchor the collector and the app use for the horizon). FUTURE and TODAY rows are never
// touched. Deletion is done in bounded batches (never one DELETE over the whole table). Runs once a
// day via .github/workflows/cleanup-window-prices.yml, and by hand:
//   PowerShell:  $env:SUPABASE_SERVICE_KEY="..."; node scripts/cleanup-window-prices.mjs
//   bash:        SUPABASE_SERVICE_KEY=... node scripts/cleanup-window-prices.mjs
//
// Modelled on scripts/cleanup-app-errors.mjs. Differences from that table:
//   • the cut is DEPARTURE DATE, not row age — a window is stale the day after it departs, not after
//     a fixed retention;
//   • window_prices has a COMPOSITE primary key (no surrogate id), so batches are paged and deleted
//     by an ascending departure_at watermark instead of by a list of ids;
//   • delete rights already exist — migration 20260810120000_window_prices.sql grants service_role
//     select/insert/update/DELETE on the table. NO new migration is needed for this script.
//
// The table is created by hand (its migration) and may not exist when this first runs: a missing
// table is treated as a clean no-op — logged, exit 0 — not a failure.
//
// SAFETY: the cleanup only ever deletes departure_at < today; the window sweep only writes FUTURE
// windows (departure = window start, in the horizon). The two act on disjoint date ranges and can
// never fight over a row, even if they overlap in time.
//
// ENV:
//   SUPABASE_SERVICE_KEY — Supabase service-role key, deletes past RLS (required, SECRET).
//   SUPABASE_URL         — project URL (public, NOT a secret; default below).
//   PLAN_DATE            — override "today" (YYYY-MM-DD) for a reproducible cut (optional).

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xpalogebawoljlafsafs.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const BATCH = 500;           // rows paged/deleted per iteration — bounded, never one delete over the whole table
const MAX_BATCHES = 100000;  // backstop so an unexpected condition can never spin forever

if (!SUPABASE_SERVICE_KEY) {
  console.error('Missing required secret:');
  console.error('  • SUPABASE_SERVICE_KEY (Supabase service-role key) is not set.');
  console.error('  PowerShell:  $env:SUPABASE_SERVICE_KEY="..."; node scripts/cleanup-window-prices.mjs');
  console.error('  bash:        SUPABASE_SERVICE_KEY=... node scripts/cleanup-window-prices.mjs');
  process.exit(1);
}

// Confirm the key is service_role (anon would be denied by RLS on delete) — same guard as the
// sibling scripts. Warn only; the delete itself will fail loudly if the role is wrong.
function keyRole(key) {
  try {
    const seg = key.split('.')[1];
    if (!seg) return '(opaque non-JWT key)';
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')).role || '(no role claim)';
  } catch { return '(unreadable)'; }
}
if (keyRole(SUPABASE_SERVICE_KEY) !== 'service_role') {
  console.warn(`WARNING: SUPABASE_SERVICE_KEY role = "${keyRole(SUPABASE_SERVICE_KEY)}" (expected "service_role") — deletes will likely be denied.`);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// A not-yet-created table is a clean no-op, never a failure. PostgREST reports it as PGRST205
// ("Could not find the table … in the schema cache"); a direct Postgres path would be 42P01
// (undefined_table). Match both, and the human-readable variants.
function tableMissing(error) {
  if (!error) return false;
  const code = error.code || '';
  const msg = (error.message || '').toLowerCase();
  return code === 'PGRST205' || code === '42P01'
    || msg.includes('does not exist')
    || msg.includes('could not find the table')
    || msg.includes('schema cache');
}

// "Today" in Europe/Berlin — the anchor the collector and the app use for the horizon. PLAN_DATE
// overrides it for a reproducible cut. departure_at is a DATE column, so a 'YYYY-MM-DD' string
// compares correctly. A window departing TODAY has not passed yet, so the cut is strictly `<`.
const cutoff = (process.env.PLAN_DATE || '').trim()
  || new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' }); // 'YYYY-MM-DD'

console.log(`Supabase: ${SUPABASE_URL}`);
console.log(`window_prices cleanup — removing rows whose departure has passed (departure_at < ${cutoff}). Future/today rows are left untouched.`);

let total = 0;
for (let batches = 0; batches < MAX_BATCHES; batches += 1) {
  // Take a bounded slice of the oldest expired rows, ordered by departure_at so the slice is stable
  // and the watermark below is its largest (still-past) departure date.
  const { data, error } = await supabase
    .from('window_prices')
    .select('departure_at')
    .lt('departure_at', cutoff)
    .order('departure_at', { ascending: true })
    .limit(BATCH);

  if (error) {
    if (tableMissing(error)) {
      console.log('window_prices table does not exist yet — nothing to clean. Exiting successfully.');
      process.exit(0);
    }
    console.error(`Select failed: ${error.code || ''} ${error.message || error}`);
    process.exit(1);
  }

  if (!data.length) break; // nothing (left) with a past departure date

  // Delete every row up to and including the watermark date. The watermark came from a `< cutoff`
  // slice, so it is itself strictly before today — the extra `.lt(cutoff)` is a belt-and-braces
  // guarantee that a future/today row can never be deleted. Composite PK has no id to list, so we
  // bound the delete by this date instead. The min departure_at strictly advances past the watermark
  // each pass, so the loop converges; each pass touches one bounded band of oldest dates.
  const watermark = data[data.length - 1].departure_at;
  const { error: delErr, count } = await supabase
    .from('window_prices')
    .delete({ count: 'exact' })
    .lt('departure_at', cutoff)
    .lte('departure_at', watermark);

  if (delErr) {
    if (tableMissing(delErr)) {
      console.log('window_prices table does not exist yet — nothing to clean. Exiting successfully.');
      process.exit(0);
    }
    console.error(`Delete failed: ${delErr.code || ''} ${delErr.message || delErr}`);
    process.exit(1);
  }

  const removed = count ?? 0;
  total += removed;
  console.log(`  batch ${batches + 1}: deleted ${removed} up to departure_at ${watermark} (running total ${total}).`);

  if (data.length < BATCH) break; // last, partial slice — nothing older remains beyond it
  if (removed === 0) break;        // defensive: nothing actually deleted, don't spin
}

console.log(`Done. Deleted ${total} window_prices row(s) with a past departure date (departure_at < ${cutoff}).`);
