// Daily bounded cleanup of raw flight-price feedback. Aggregated reports may be kept separately;
// raw route/date/party/booking rows are removed after 365 days.
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xpalogebawoljlafsafs.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const RETENTION_DAYS = 365;
const BATCH = 500;
const MAX_BATCHES = 100000;

if (!SUPABASE_SERVICE_KEY) {
  console.error('Missing required secret: SUPABASE_SERVICE_KEY.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false },
});

function tableMissing(error) {
  if (!error) return false;
  const code = error.code || '';
  const msg = (error.message || '').toLowerCase();
  return code === 'PGRST205' || code === '42P01'
    || msg.includes('does not exist') || msg.includes('could not find the table')
    || msg.includes('schema cache');
}

const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400000).toISOString();
console.log(`flight_price_feedback cleanup — removing raw rows older than ${RETENTION_DAYS} days (created_at < ${cutoff}).`);

let total = 0;
for (let batches = 0; batches < MAX_BATCHES; batches += 1) {
  const { data, error } = await supabase.from('flight_price_feedback')
    .select('id').lt('created_at', cutoff).order('created_at', { ascending: true }).limit(BATCH);
  if (error) {
    if (tableMissing(error)) {
      console.log('flight_price_feedback table does not exist yet — nothing to clean.');
      process.exit(0);
    }
    console.error(`Select failed: ${error.code || ''} ${error.message || error}`);
    process.exit(1);
  }
  if (!data.length) break;

  const ids = data.map((row) => row.id);
  const { error: deleteError, count } = await supabase.from('flight_price_feedback')
    .delete({ count: 'exact' }).in('id', ids);
  if (deleteError) {
    if (tableMissing(deleteError)) process.exit(0);
    console.error(`Delete failed: ${deleteError.code || ''} ${deleteError.message || deleteError}`);
    process.exit(1);
  }
  const removed = count ?? ids.length;
  total += removed;
  console.log(`  batch ${batches + 1}: deleted ${removed} (running total ${total}).`);
  if (data.length < BATCH || removed === 0) break;
}

console.log(`Done. Deleted ${total} flight_price_feedback row(s) older than ${RETENTION_DAYS} days.`);
