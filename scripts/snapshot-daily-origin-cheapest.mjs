import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';
import { marketForOrigin } from '../src/data/origin-markets.js';
import { DESTINATIONS } from '../src/data/destinations.js';
import { expansionTargets } from '../src/data/expansion-targets.js';
import { ORIGINS_ALL } from '../src/data/origins.js';
import { destinationIdForIata } from '../src/data/destination-identities.js';

export function publishedSnapshotDestinations(wave=0){
  return new Set([...DESTINATIONS,...expansionTargets(wave)].map(d=>d.iata));
}
export function publishedSnapshotOrigins(){return new Set(ORIGINS_ALL);}

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

// Single selection-owner, once per observed day. Selection is the ONLY step allowed to
// define pool membership/order/rank. A cheap existence probe of the current day's pool
// decides whether selection already ran, so a second same-day trigger (an end-of-session
// republish, a resumed/late main completion, or a manual rerun) leaves the immutable pool
// untouched. This uses the existing observed_on column — no new table or migration.
export function poolExistsForObservedOn(rows, observedOn) {
  if (!Array.isArray(rows)) return false;
  return rows.some((row) => (row?.observed_on ?? observedOn) === observedOn);
}

export function berlinObservedOn(value = Date.now()) {
  const timestamp = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(timestamp)) throw new Error('Invalid snapshot timestamp');
  return new Date(timestamp).toLocaleDateString('en-CA',{timeZone:'Europe/Berlin'});
}

export function nightlySelectionDue(value = Date.now()) {
  const timestamp=typeof value==='number'?value:Date.parse(value);
  if(!Number.isFinite(timestamp))throw new Error('Invalid selection timestamp');
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Berlin',hour:'2-digit',minute:'2-digit',hourCycle:'h23'})
    .formatToParts(new Date(timestamp)).filter(p=>p.type!=='literal').map(p=>[p.type,p.value]));
  return Number(parts.hour)*60+Number(parts.minute)>=3*60+30;
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

export async function main({ db, snapshotAt: requestedSnapshotAt, expansionWave=Number(process.env.SNAPSHOT_EXPANSION_WAVE||0),
  force=process.env.SNAPSHOT_FORCE_REBUILD==='true' } = {}) {
  if (!SUPABASE_SERVICE_KEY) throw new Error('Missing required secret: SUPABASE_SERVICE_KEY.');
  const instant=requestedSnapshotAt??Date.now();const observedOn = berlinObservedOn(instant);
  if(!force&&!nightlySelectionDue(instant))return{rebuilt:false,observedOn,snapshotAt:null,reason:'not_due'};
  const supabase = db ?? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });

  const freshSince = new Date(Date.now() - MAX_SOURCE_AGE_MS).toISOString();
  const offers = [];
  const publishedDestinations=publishedSnapshotDestinations(expansionWave);
  const origins=publishedSnapshotOrigins();
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase.from('offers')
    .select('origin,market,dest,flight_type,price,departure_at,return_at,transfers,updated_at,price_source')
    .gte('departure_at', observedOn).gte('updated_at', freshSince).gt('price', 0)
    .order('origin').order('flight_type').order('price').order('dest').order('departure_at').order('return_at').range(from, from + PAGE - 1);
    if (error) throw error;
    // Collection can warm new airports before their app metadata/weather/photos
    // are ready. Do not let an unknown destination displace the published pool.
    offers.push(...data.filter(row=>origins.has(row.origin)&&publishedDestinations.has(row.dest)));
    if (data.length < PAGE) break;
  }

  const snapshotAt = requestedSnapshotAt ?? new Date().toISOString();
  const pool = selectDailyCheapestPool(offers, observedOn, 10).map((row) => ({
  observed_on: observedOn,
  snapshot_at: snapshotAt,
  created_at: snapshotAt,
  origin: row.origin,
  market: row.market || marketForOrigin(row.origin),
  flight_type: row.flight_type,
  rank: row.rank,
  dest: row.dest,
  destination_id: destinationIdForIata(row.dest),
  price: Number(row.price),
  currency: 'EUR',
  departure_at: row.departure_at,
  return_at: row.return_at || null,
  transfers: Number(row.transfers ?? 0),
  source_updated_at: row.updated_at || null,
  price_source: row.price_source || null,
  }));
  // Keep the compatibility table's historical contract: one rank-1 row for each origin/mode.
  // The roulette pool above is intentionally different: ten unique destinations per origin.
  const chosen = selectDailyCheapest(offers, observedOn).map((row) => ({
    observed_on: observedOn,
    snapshot_at: snapshotAt,
    created_at: snapshotAt,
    origin: row.origin,
    market: row.market || marketForOrigin(row.origin),
    flight_type: row.flight_type,
    dest: row.dest,
    destination_id: destinationIdForIata(row.dest),
    price: Number(row.price),
    currency: 'EUR',
    departure_at: row.departure_at,
    return_at: row.return_at || null,
    transfers: Number(row.transfers ?? 0),
    source_updated_at: row.updated_at || null,
  price_source: row.price_source || null,
  }));

  if (!chosen.length) throw new Error('No valid future offers found; refusing to write an empty daily snapshot.');

  const {data:didPublish,error:publishError}=await supabase.rpc('publish_daily_cheapest_selection',{
    p_observed_on:observedOn,p_snapshot_at:snapshotAt,p_rank1:chosen,p_pool:pool,p_force:force});
  if(publishError)throw publishError;
  if(didPublish!==true){console.log(`daily_origin_cheapest_pool already selected for ${observedOn}; membership/order/rank left untouched.`);
    return{rebuilt:false,observedOn,snapshotAt:null,reason:'already_published'};}
  console.log(`Saved ${chosen.length} rank-1 rows and ${pool.length} pool rows for ${observedOn} from ${offers.length} future offers.`);
  return { rebuilt: true, observedOn, snapshotAt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message || error); process.exit(1); });
}
