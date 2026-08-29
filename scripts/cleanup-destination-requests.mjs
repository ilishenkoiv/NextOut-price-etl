// Daily bounded cleanup of voluntary destination requests. Raw city/country requests are kept
// for at most 24 calendar months, matching the public Privacy Policy and Play Data Safety answers.
import { createClient } from '@supabase/supabase-js';
import { calendarMonthsAgoIso, DESTINATION_REQUEST_RETENTION_MONTHS } from './destination-request-retention.mjs';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xpalogebawoljlafsafs.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
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

const cutoff = calendarMonthsAgoIso(new Date());
console.log(`destination_requests cleanup — removing rows older than ${DESTINATION_REQUEST_RETENTION_MONTHS} calendar months (created_at < ${cutoff}).`);

let total = 0;
for (let batches = 0; batches < MAX_BATCHES; batches += 1) {
  const { data, error } = await supabase.from('destination_requests')
    .select('id').lt('created_at', cutoff).order('created_at', { ascending: true }).limit(BATCH);
  if (error) {
    if (tableMissing(error)) {
      console.log('destination_requests table does not exist yet — nothing to clean.');
      process.exit(0);
    }
    console.error(`Select failed: ${error.code || ''} ${error.message || error}`);
    process.exit(1);
  }
  if (!data.length) break;

  const ids = data.map((row) => row.id);
  const { error: deleteError, count } = await supabase.from('destination_requests')
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

console.log(`Done. Deleted ${total} destination_requests row(s) older than ${DESTINATION_REQUEST_RETENTION_MONTHS} calendar months.`);
