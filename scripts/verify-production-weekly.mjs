import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@supabase/supabase-js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const configPath = process.env.NEXTOUT_APP_CONFIG;
if (!configPath) throw new Error('NEXTOUT_APP_CONFIG is required');
const config = await readFile(configPath, 'utf8');
const url = config.match(/SUPABASE_URL\s*=\s*"([^"]+)"/)?.[1];
const anonKey = config.match(/SUPABASE_ANON_KEY\s*=\s*"([^"]+)"/)?.[1];
if (!url || !anonKey) throw new Error('Public Supabase config was not found');

const expected = JSON.parse(await readFile(path.join(root, 'data', 'weather-weekly-normals.json'), 'utf8'));
const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const actual = [];
for (let offset = 0; ; offset += 1000) {
  const { data, error } = await supabase
    .from('weather_weekly_normals')
    .select('iata,iso_week,avg_tmax,avg_tmin,precip_mm,rain_days,rain_probability,heavy_rain_probability,brief_shower_probability,changeable_probability,rainy_day_probability,avg_rain_hours_wet_day,avg_sun_h,sample_years,period_start,period_end')
    .order('iata', { ascending: true })
    .order('iso_week', { ascending: true })
    .range(offset, offset + 999);
  if (error) throw error;
  actual.push(...(data ?? []));
  if ((data ?? []).length < 1000) break;
}

const order = (rows) => [...rows].sort((a, b) => a.iata.localeCompare(b.iata) || a.iso_week - b.iso_week);
const canonical = (row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? Number(value) : value]));
const expectedText = JSON.stringify(order(expected).map(canonical));
const actualText = JSON.stringify(order(actual).map(canonical));
if (actual.length !== 7367) throw new Error(`production row count: ${actual.length}, expected 7367`);
if (actualText !== expectedText) throw new Error('production payload differs from locally verified weekly normals');

const byIata = new Map();
for (const row of actual) {
  if (!byIata.has(row.iata)) byIata.set(row.iata, []);
  byIata.get(row.iata).push(row.iso_week);
}
if (byIata.size !== 139) throw new Error(`production destinations: ${byIata.size}, expected 139`);
for (const [iata, weeks] of byIata) {
  weeks.sort((a, b) => a - b);
  if (weeks.length !== 53 || weeks.some((week, index) => week !== index + 1)) {
    throw new Error(`${iata}: missing or duplicate production ISO week`);
  }
}

console.log(JSON.stringify({
  productionReadback: 'green',
  rows: actual.length,
  destinations: byIata.size,
  weeksPerDestination: 53,
  exactPayloadMatch: true,
  samples: actual.filter((row) => ['BER', 'PMI', 'MLE', 'SEZ'].includes(row.iata) && [3, 30].includes(row.iso_week)),
}, null, 2));
