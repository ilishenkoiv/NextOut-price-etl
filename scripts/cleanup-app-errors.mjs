// scripts/cleanup-app-errors.mjs — daily cleanup of the app-error report table.
//
// Deletes rows from public.app_errors once they are older than 90 days, in bounded batches
// (never one DELETE over the whole table). Runs once a day via
// .github/workflows/cleanup-app-errors.yml, and by hand:
//   PowerShell:  $env:SUPABASE_SERVICE_KEY="..."; node scripts/cleanup-app-errors.mjs
//   bash:        SUPABASE_SERVICE_KEY=... node scripts/cleanup-app-errors.mjs
//
// The table is created by hand (a separate migration) and may not exist when this first runs:
// a missing table is treated as a clean no-op — logged, exit 0 — not a failure.
//
// ENV:
//   SUPABASE_SERVICE_KEY — Supabase service-role key, deletes past RLS (required, SECRET).
//   SUPABASE_URL         — project URL (public, NOT a secret; default below).

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xpalogebawoljlafsafs.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

const RETENTION_DAYS = 90;   // delete anything created before this many days ago
const BATCH = 500;           // rows per DELETE — bounded, never one delete over the whole table
const MAX_BATCHES = 100000;  // backstop so an unexpected condition can never spin forever

if (!SUPABASE_SERVICE_KEY) {
  console.error('Missing required secret:');
  console.error('  • SUPABASE_SERVICE_KEY (Supabase service-role key) is not set.');
  console.error('  PowerShell:  $env:SUPABASE_SERVICE_KEY="..."; node scripts/cleanup-app-errors.mjs');
  console.error('  bash:        SUPABASE_SERVICE_KEY=... node scripts/cleanup-app-errors.mjs');
  process.exit(1);
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

const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
console.log(`Supabase: ${SUPABASE_URL}`);
console.log(`app_errors cleanup — removing rows older than ${RETENTION_DAYS} days (created_at < ${cutoff}).`);

let total = 0;
for (let batches = 0; batches < MAX_BATCHES; batches += 1) {
  // Take a bounded slice of the oldest expired ids (ordered, so the slice is stable)…
  const { data, error } = await supabase
    .from('app_errors')
    .select('id')
    .lt('created_at', cutoff)
    .order('created_at', { ascending: true })
    .limit(BATCH);

  if (error) {
    if (tableMissing(error)) {
      console.log('app_errors table does not exist yet — nothing to clean. Exiting successfully.');
      process.exit(0);
    }
    console.error(`Select failed: ${error.code || ''} ${error.message || error}`);
    process.exit(1);
  }

  if (!data.length) break; // nothing (left) older than the cutoff

  // …then delete exactly those ids. Deleted rows drop out of the next select, so the loop
  // converges; each pass touches at most BATCH rows.
  const ids = data.map((r) => r.id);
  const { error: delErr, count } = await supabase
    .from('app_errors')
    .delete({ count: 'exact' })
    .in('id', ids);

  if (delErr) {
    if (tableMissing(delErr)) {
      console.log('app_errors table does not exist yet — nothing to clean. Exiting successfully.');
      process.exit(0);
    }
    console.error(`Delete failed: ${delErr.code || ''} ${delErr.message || delErr}`);
    process.exit(1);
  }

  const removed = count ?? ids.length;
  total += removed;
  console.log(`  batch ${batches + 1}: deleted ${removed} (running total ${total}).`);

  if (data.length < BATCH) break; // last, partial slice — nothing more to fetch
  if (removed === 0) break;        // defensive: nothing actually deleted, don't spin
}

console.log(`Done. Deleted ${total} app_errors row(s) older than ${RETENTION_DAYS} days (created_at < ${cutoff}).`);
