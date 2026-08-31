import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xpalogebawoljlafsafs.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const PAGE = 1000;
const MAX_SOURCE_AGE_MS = 36 * 60 * 60 * 1000;

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
  return [...best.values()].sort((a, b) => String(a.origin).localeCompare(String(b.origin))
    || String(a.flight_type).localeCompare(String(b.flight_type)));
}

export function selectDailyCheapestPool(offers, today, limit = 10) {
  const groups = new Map();
  for (const row of offers) {
    if (!row.origin || !row.dest || !['any', 'direct'].includes(row.flight_type)) continue;
    if (!row.departure_at || row.departure_at < today || !(Number(row.price) > 0)) continue;
    // Roulette promises destinations, not ten date variants of the same city. Build one global
    // pool per origin across any/direct and retain only the cheapest real ticket per destination.
    // This prevents a route such as MUC→FCO from occupying all ten ranks by itself.
    const group = groups.get(row.origin) || new Map();
    const current = group.get(row.dest);
    if (!current || compareOffer(row, current) < 0) group.set(row.dest, row);
    groups.set(row.origin, group);
  }
  return [...groups.entries()].flatMap(([, group]) => [...group.values()]
    .sort(compareOffer).slice(0, Math.max(1, Math.min(10, limit)))
    .map((row, index) => ({ ...row, rank:index + 1 })))
    .sort((a, b) => String(a.origin).localeCompare(String(b.origin)) || a.rank - b.rank);
}

async function main() {
  if (!SUPABASE_SERVICE_KEY) throw new Error('Missing required secret: SUPABASE_SERVICE_KEY.');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const observedOn = new Date().toISOString().slice(0, 10);
  const freshSince = new Date(Date.now() - MAX_SOURCE_AGE_MS).toISOString();
  const offers = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('offers')
    .select('origin,dest,flight_type,price,departure_at,return_at,transfers,updated_at')
    .gte('departure_at', observedOn).gte('updated_at', freshSince).gt('price', 0)
    .order('origin').order('flight_type').order('price').range(from, from + PAGE - 1);
    if (error) throw error;
    offers.push(...data);
    if (data.length < PAGE) break;
  }

  const snapshotAt = new Date().toISOString();
  const pool = selectDailyCheapestPool(offers, observedOn, 10).map((row) => ({
  observed_on: observedOn,
  snapshot_at: snapshotAt,
  origin: row.origin,
  flight_type: row.flight_type,
  rank: row.rank,
  dest: row.dest,
  price: Number(row.price),
  currency: 'EUR',
  departure_at: row.departure_at,
  return_at: row.return_at || null,
  transfers: Number(row.transfers ?? 0),
  source_updated_at: row.updated_at || null,
  }));
  // Keep the compatibility table's historical contract: one rank-1 row for each origin/mode.
  // The roulette pool above is intentionally different: ten unique destinations per origin.
  const chosen = selectDailyCheapest(offers, observedOn).map((row) => ({
    observed_on: observedOn,
    snapshot_at: snapshotAt,
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

  const { error: poolError } = await supabase.from('daily_origin_cheapest_pool').insert(pool);
  if (poolError && !tableMissing(poolError)) throw poolError;
  if (poolError) console.log('daily_origin_cheapest_pool table does not exist yet — rank-1 compatibility snapshot saved.');
  else {
    const retentionCutoff = new Date(Date.now() - 31 * 86400_000).toISOString();
    const { error: cleanupError } = await supabase.from('daily_origin_cheapest_pool').delete().lt('snapshot_at', retentionCutoff);
    if (cleanupError) console.warn(`Pool retention cleanup skipped: ${cleanupError.message || cleanupError}`);
  }
  console.log(`Saved ${chosen.length} rank-1 rows and ${pool.length} pool rows for ${observedOn} from ${offers.length} future offers.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message || error); process.exit(1); });
}
