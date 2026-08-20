// scripts/collect-storage-metrics.mjs — daily storage-usage measurement.
//
// Calls the SECURITY DEFINER function public.collect_storage_metrics(), which counts every public
// table (rows + bytes), the whole database size, and the price-snapshots Storage bucket (objects +
// bytes), and INSERTS one row per item under a single measured_at. Old rows are never touched — the
// table is a history, so growth is visible over time. Runs once a day via
// .github/workflows/storage-metrics.yml, and by hand:
//   PowerShell:  $env:SUPABASE_SERVICE_KEY="..."; node scripts/collect-storage-metrics.mjs
//   bash:        SUPABASE_SERVICE_KEY=... node scripts/collect-storage-metrics.mjs
//
// The measuring is done in SQL because PostgREST exposes no size endpoint; this script only invokes
// the function and prints what it wrote. Modelled on scripts/cleanup-window-prices.mjs.
//
// The table + function are created by hand (migration 20260820120000_storage_metrics.sql) and may
// not exist when this first runs: a missing table/function is treated as a clean no-op — logged,
// exit 0 — not a failure, exactly like the cleanup jobs.
//
// ENV:
//   SUPABASE_SERVICE_KEY — Supabase service-role key; the function is EXECUTE-only for this role
//                          and the table is closed to anon (required, SECRET).
//   SUPABASE_URL         — project URL (public, NOT a secret; default below).

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xpalogebawoljlafsafs.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

if (!SUPABASE_SERVICE_KEY) {
  console.error('Missing required secret:');
  console.error('  • SUPABASE_SERVICE_KEY (Supabase service-role key) is not set.');
  console.error('  PowerShell:  $env:SUPABASE_SERVICE_KEY="..."; node scripts/collect-storage-metrics.mjs');
  console.error('  bash:        SUPABASE_SERVICE_KEY=... node scripts/collect-storage-metrics.mjs');
  process.exit(1);
}

// Confirm the key is service_role (anon cannot execute the function or read the table) — same guard
// as the sibling scripts. Warn only; the call itself fails loudly if the role is wrong.
function keyRole(key) {
  try {
    const seg = key.split('.')[1];
    if (!seg) return '(opaque non-JWT key)';
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')).role || '(no role claim)';
  } catch { return '(unreadable)'; }
}
if (keyRole(SUPABASE_SERVICE_KEY) !== 'service_role') {
  console.warn(`WARNING: SUPABASE_SERVICE_KEY role = "${keyRole(SUPABASE_SERVICE_KEY)}" (expected "service_role") — the call will likely be denied.`);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

// A not-yet-created table OR function is a clean no-op, never a failure. PostgREST reports a missing
// table as PGRST205 and a missing function as PGRST202; a direct Postgres path would be 42P01
// (undefined_table) / 42883 (undefined_function). Match those and the human-readable variants.
function objectMissing(error) {
  if (!error) return false;
  const code = error.code || '';
  const msg = (error.message || '').toLowerCase();
  return code === 'PGRST205' || code === 'PGRST202' || code === '42P01' || code === '42883'
    || msg.includes('does not exist')
    || msg.includes('could not find the table')
    || msg.includes('could not find the function')
    || msg.includes('schema cache');
}

const mb = (bytes) => (Number(bytes) / (1024 * 1024)).toFixed(2);

console.log(`Supabase: ${SUPABASE_URL}`);
console.log('storage metrics — calling collect_storage_metrics() (one measurement appended; old rows untouched).');

const { data, error } = await supabase.rpc('collect_storage_metrics');

if (error) {
  if (objectMissing(error)) {
    console.log('storage_metrics table/function not applied yet (migration 20260820120000) — nothing recorded. Exiting successfully.');
    process.exit(0);
  }
  console.error(`collect_storage_metrics() failed: ${error.code || ''} ${error.message || error}`);
  process.exit(1);
}

const rows = Array.isArray(data) ? data : [];
if (!rows.length) {
  console.warn('The function returned no rows — nothing appears to have been recorded. Investigate.');
  process.exit(1);
}

const measuredAt = rows[0].measured_at;
const tables = rows.filter((r) => r.kind === 'table').sort((a, b) => Number(b.bytes) - Number(a.bytes));
const dbTotal = rows.find((r) => r.kind === 'db_total');
const bucket = rows.find((r) => r.kind === 'snapshot_bucket');

console.log(`\nRecorded ${rows.length} row(s) at measured_at ${measuredAt}:`);
console.log('  ' + 'TABLE'.padEnd(26) + 'ROWS'.padStart(12) + 'SIZE (MB)'.padStart(14));
console.log('  ' + '-'.repeat(52));
for (const t of tables) {
  console.log('  ' + String(t.name).padEnd(26) + String(t.row_count ?? '-').padStart(12) + mb(t.bytes).padStart(14));
}
console.log('  ' + '-'.repeat(52));
if (dbTotal) console.log('  ' + 'DATABASE (total)'.padEnd(26) + '-'.padStart(12) + mb(dbTotal.bytes).padStart(14) + `  (of 500 MB free tier)`);
if (bucket) console.log('  ' + 'price-snapshots (bucket)'.padEnd(26) + String(bucket.row_count ?? '-').padStart(12) + mb(bucket.bytes).padStart(14) + `  (Storage, of 1 GB free tier)`);

console.log(`\nDone. Appended one measurement (${rows.length} rows). History preserved.`);
