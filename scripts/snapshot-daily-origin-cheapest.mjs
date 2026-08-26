import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xpalogebawoljlafsafs.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PAGE = 1000;

function tableMissing(error) {
  const code = error?.code || '';
  const msg = (error?.message || '').toLowerCase();
  return code === 'PGRST205' || code === '42P01' || msg.includes('schema cache') || msg.includes('does not exist');
}

export function compareOffer(a, b) {
  return Number(a.price) - Number(b.price)
    || String(b.updated_at || '').localeCompare(String(a.updated_at || ''))
    || Number(a.transfers ?? 0) - Number(b.transfers ?? 0)
    || String(a.departure_at).localeCompare(String(b.departure_at))
    || String(a.dest).localeCompare(String(b.dest));
}

export function selectDailyCheapest(offers, today) {
  const best = new Map();
  for (const row of offers) {
    if (!row.origin || !row.dest || !['any', 'direct'].includes(row.flight_type)) continue;
    if (!row.departure_at || row.departure_at < today || !(Number(row.price) > 0)) continue;
    const key = `${row.origin}|${row.flight_type}`;
    const current = best.get(key);
    if (!current || compareOffer(row, current) < 0) best.set(key, row);
  }
  return [...best.values()];
}

async function main() {
  if (!SUPABASE_SERVICE_KEY) throw new Error('Missing required secret: SUPABASE_SERVICE_KEY.');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const observedOn = new Date().toISOString().slice(0, 10);
  const offers = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('offers')
    .select('origin,dest,flight_type,price,departure_at,return_at,transfers,updated_at')
    .gte('departure_at', observedOn).gt('price', 0)
    .order('origin').order('flight_type').order('price').range(from, from + PAGE - 1);
    if (error) throw error;
    offers.push(...data);
    if (data.length < PAGE) break;
  }

const chosen = selectDailyCheapest(offers, observedOn).map((row) => ({
  observed_on: observedOn,
  origin: row.origin,
  flight_type: row.flight_type,
  dest: row.dest,
  price: Number(row.price),
  currency: 'EUR',
  departure_at: row.departure_at,
  return_at: row.return_at || null,
  transfers: Number(row.transfers ?? 0),
  source_updated_at: row.updated_at || null,
}));

  if (!chosen.length) throw new Error('No valid future offers found; refusing to write an empty daily snapshot.');

const { error: writeError } = await supabase.from('daily_origin_cheapest')
  .upsert(chosen, { onConflict: 'observed_on,origin,flight_type' });
  if (writeError) {
    if (tableMissing(writeError)) {
      console.log('daily_origin_cheapest table does not exist yet — snapshot skipped safely.');
      return;
    }
    throw writeError;
  }
  console.log(`Saved ${chosen.length} daily cheapest rows for ${observedOn} from ${offers.length} future offers.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message || error); process.exit(1); });
}
