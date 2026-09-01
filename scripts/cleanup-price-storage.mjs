// Quarterly retention for private price snapshots and window-sweep resume markers.
// Canonical snapshots are kept for one year; operational progress markers for 35 days.

import { createClient } from '@supabase/supabase-js';
import {
  PROGRESS_RETENTION_DAYS,
  SNAPSHOT_RETENTION_DAYS,
  positiveDays,
  retentionCutoff,
  shouldDeleteSnapshot,
} from './price-storage-retention.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xpalogebawoljlafsafs.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = 'price-snapshots';
const LIST_PAGE = 1000;
const REMOVE_BATCH = 100;
const ROW_BATCH = 500;
const dryRun = ['1', 'true', 'yes'].includes(String(process.env.DRY_RUN || '').trim().toLowerCase());

if (!SUPABASE_SERVICE_KEY) {
  console.error('Missing required secret: SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

const snapshotDays = positiveDays(process.env.SNAPSHOT_RETENTION_DAYS, SNAPSHOT_RETENTION_DAYS);
const progressDays = positiveDays(process.env.PROGRESS_RETENTION_DAYS, PROGRESS_RETENTION_DAYS);
const today = (process.env.PLAN_DATE || '').trim()
  || new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
const snapshotCutoff = retentionCutoff(today, snapshotDays);
const progressCutoff = retentionCutoff(today, progressDays);
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

function tableMissing(error) {
  const code = error?.code || '';
  const message = String(error?.message || '').toLowerCase();
  return code === 'PGRST205' || code === '42P01'
    || message.includes('could not find the table') || message.includes('does not exist');
}

async function listObjects(prefix) {
  const objects = [];
  for (let offset = 0; ; offset += LIST_PAGE) {
    const { data, error } = await supabase.storage.from(BUCKET).list(prefix, {
      limit: LIST_PAGE,
      offset,
      sortBy: { column: 'name', order: 'asc' },
    });
    if (error) throw new Error(`Storage list failed for ${prefix}: ${error.message || error}`);
    for (const item of data || []) {
      const key = prefix ? `${prefix}/${item.name}` : item.name;
      if (item.id || item.metadata) objects.push(key);
      else objects.push(...await listObjects(key));
    }
    if (!data || data.length < LIST_PAGE) break;
  }
  return objects;
}

async function cleanupSnapshots() {
  const objects = await listObjects('snapshots');
  const expired = objects.filter((key) => shouldDeleteSnapshot(key, snapshotCutoff));
  if (dryRun) {
    console.log(`Snapshots dry-run: would delete ${expired.length}; canonical objects dated ${snapshotCutoff} or newer remain.`);
    return;
  }
  let removed = 0;
  for (let i = 0; i < expired.length; i += REMOVE_BATCH) {
    const batch = expired.slice(i, i + REMOVE_BATCH);
    const { data, error } = await supabase.storage.from(BUCKET).remove(batch);
    if (error) throw new Error(`Storage remove failed: ${error.message || error}`);
    removed += data?.length ?? batch.length;
  }
  console.log(`Snapshots: deleted ${removed}; kept canonical objects dated ${snapshotCutoff} or newer.`);
}

async function cleanupProgress() {
  if (dryRun) {
    const { count, error } = await supabase
      .from('window_price_progress')
      .select('*', { count: 'exact', head: true })
      .lt('plan_date', progressCutoff);
    if (error) {
      if (tableMissing(error)) {
        console.log('window_price_progress does not exist yet — marker cleanup is a no-op.');
        return;
      }
      throw new Error(`Progress count failed: ${error.message || error}`);
    }
    console.log(`Progress dry-run: would delete ${count ?? 0}; plan_date ${progressCutoff} or newer remains.`);
    return;
  }
  let removed = 0;
  for (;;) {
    const { data, error } = await supabase
      .from('window_price_progress')
      .select('plan_date')
      .lt('plan_date', progressCutoff)
      .order('plan_date', { ascending: true })
      .limit(ROW_BATCH);
    if (error) {
      if (tableMissing(error)) {
        console.log('window_price_progress does not exist yet — marker cleanup is a no-op.');
        return;
      }
      throw new Error(`Progress select failed: ${error.message || error}`);
    }
    if (!data?.length) break;
    const watermark = data[data.length - 1].plan_date;
    const { error: deleteError, count } = await supabase
      .from('window_price_progress')
      .delete({ count: 'exact' })
      .lt('plan_date', progressCutoff)
      .lte('plan_date', watermark);
    if (deleteError) throw new Error(`Progress delete failed: ${deleteError.message || deleteError}`);
    const deleted = count ?? 0;
    removed += deleted;
    if (data.length < ROW_BATCH || deleted === 0) break;
  }
  console.log(`Progress: deleted ${removed}; kept plan_date ${progressCutoff} or newer.`);
}

console.log(`Retention date ${today}: snapshots ${snapshotDays} days, progress ${progressDays} days, dry-run ${dryRun}.`);
await cleanupSnapshots();
await cleanupProgress();
console.log('Price storage cleanup complete.');
