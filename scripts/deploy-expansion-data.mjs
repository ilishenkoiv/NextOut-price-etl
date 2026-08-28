// Targeted rollout for the AMS/LHR + German-destinations expansion.
// Default is a read-free DRY RUN. Production writes require BOTH an explicit --apply flag and
// SUPABASE_SERVICE_KEY in the environment; the key is never printed or stored.

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const APPLY = process.argv.includes('--apply');
const WEATHER_ONLY = process.argv.includes('--weather-only');
const GERMAN_DESTINATIONS = ['BER', 'MUC', 'FRA', 'DUS', 'HAM', 'STR', 'CGN'];
const ORIGIN_ROWS = [
  { airport:'AMS', physical_country:'NL', physical_subdivision_code:'NL-NH', calendar_country:'NL', calendar_subdivision_code:'NL-NH' },
  { airport:'LHR', physical_country:'GB', physical_subdivision_code:'GB-ENG', calendar_country:'GB', calendar_subdivision_code:'GB-ENG' },
];

const climate = JSON.parse(await readFile(path.join(ROOT, 'data', 'weather-climate.json'), 'utf8'))
  .filter((row) => GERMAN_DESTINATIONS.includes(row.iata));
const coverage = new Map(GERMAN_DESTINATIONS.map((iata) => [iata, 0]));
for (const row of climate) coverage.set(row.iata, (coverage.get(row.iata) ?? 0) + 1);
const incomplete = [...coverage].filter(([, count]) => count !== 12);
if (climate.length !== 84 || incomplete.length) {
  throw new Error(`German climate coverage must be 7×12=84; got ${climate.length}. Incomplete: ${incomplete.map(([iata,count]) => `${iata}:${count}`).join(', ') || 'none'}`);
}

if (!WEATHER_ONLY) console.log(`Plan: upsert ${ORIGIN_ROWS.length} origin_regions rows (AMS, LHR)`);
console.log(`Plan: upsert ${climate.length} weather_climate rows (${GERMAN_DESTINATIONS.join(', ')}, 12 months each)`);
if (!APPLY) {
  console.log('DRY RUN — no network request and no write. Add --apply with SUPABASE_SERVICE_KEY to deploy.');
  process.exit(0);
}

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xpalogebawoljlafsafs.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
if (!SUPABASE_SERVICE_KEY) throw new Error('SUPABASE_SERVICE_KEY is required with --apply');

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession:false, autoRefreshToken:false },
  realtime: { transport:WebSocket },
});

if (!WEATHER_ONLY) {
  const originsWrite = await supabase.from('origin_regions').upsert(ORIGIN_ROWS, { onConflict:'airport' });
  if (originsWrite.error) throw new Error(`origin_regions upsert failed: ${originsWrite.error.message}`);
}

const climateWrite = await supabase.from('weather_climate').upsert(climate, { onConflict:'iata,month' });
if (climateWrite.error) throw new Error(`weather_climate upsert failed: ${climateWrite.error.message}`);

if (!WEATHER_ONLY) {
  const originsCheck = await supabase.from('origin_regions').select('airport').in('airport', ['AMS','LHR']);
  if (originsCheck.error || originsCheck.data?.length !== 2) throw new Error(`origin verification failed: ${originsCheck.error?.message ?? originsCheck.data?.length}`);
}
const climateCheck = await supabase.from('weather_climate').select('iata,month').in('iata', GERMAN_DESTINATIONS);
if (climateCheck.error || climateCheck.data?.length !== 84) throw new Error(`climate verification failed: ${climateCheck.error?.message ?? climateCheck.data?.length}`);

console.log(WEATHER_ONLY
  ? 'Applied and verified: 84 German climate rows (7 cities × 12 months).'
  : 'Applied and verified: 2 origin regions + 84 climate rows.');
