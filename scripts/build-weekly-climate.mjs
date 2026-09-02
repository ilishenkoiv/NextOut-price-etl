// Copernicus daily intermediates → weekly climate-normal JSON + production SQL.
// Run fetch-copernicus-weekly.py first. SQL is emitted only at full destination coverage.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEST_COORDS } from '../src/data/coords.js';
import { aggregateWeeklyNormalsFromDaily } from './weekly-climate-aggregate.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_ROOT = path.join(ROOT, 'data', 'copernicus-weekly');
const keyOf = (lat, lng) => `${lat.toFixed(3)}_${lng.toFixed(3)}`.replaceAll('-', 'm').replaceAll('.', 'p');
const rows = [];
const missing = [];

for (const [iata, [lat, lng]] of Object.entries(DEST_COORDS)) {
  const file = path.join(DATA_ROOT, 'daily', `${keyOf(lat, lng)}.json`);
  try {
    const daily = JSON.parse(await readFile(file, 'utf8'));
    const weekly = aggregateWeeklyNormalsFromDaily(daily, 1991, 2020);
    if (weekly.length < 52) throw new Error(`only ${weekly.length} weeks`);
    rows.push(...weekly.map((row) => ({ iata, ...row })));
  } catch (error) {
    missing.push(`${iata}: ${error.message}`);
  }
}

await mkdir(path.join(ROOT, 'data'), { recursive:true });

if (missing.length) {
  await writeFile(path.join(ROOT, 'data', 'weather-weekly-normals.partial.json'), JSON.stringify(rows, null, 2));
  console.error(`Weekly climate incomplete: ${Object.keys(DEST_COORDS).length - missing.length}/${Object.keys(DEST_COORDS).length} destinations.`);
  for (const line of missing) console.error(`  ${line}`);
  console.error('SQL NOT generated. Configure CDS access and rerun fetch-copernicus-weekly.py.');
  process.exitCode = 1;
} else {
  await writeFile(path.join(ROOT, 'data', 'weather-weekly-normals.json'), JSON.stringify(rows, null, 2));
  const migration = path.join(ROOT, 'migrations', '20260901160000_weather_weekly_normals.sql');
  let sql = `-- Copernicus ERA5-Land weekly climate normals, 1991-2020.\n` +
    `-- Generated using Copernicus Climate Change Service information [2026].\n` +
    `truncate public.weather_weekly_normals;\n\n`;
  const batchSize = 300;
  for (let offset=0; offset<rows.length; offset+=batchSize) {
    const batch = rows.slice(offset, offset+batchSize);
    sql += `insert into public.weather_weekly_normals (` +
      `iata,iso_week,avg_tmax,avg_tmin,precip_mm,rain_days,rain_probability,heavy_rain_probability,` +
      `brief_shower_probability,changeable_probability,rainy_day_probability,avg_rain_hours_wet_day,avg_sun_h,sample_years,period_start,period_end) values\n`;
    sql += batch.map((r) => `  ('${r.iata}',${r.iso_week},${r.avg_tmax},${r.avg_tmin},${r.precip_mm},${r.rain_days},${r.rain_probability},${r.heavy_rain_probability},${r.brief_shower_probability},${r.changeable_probability},${r.rainy_day_probability},${r.avg_rain_hours_wet_day},${r.avg_sun_h},${r.sample_years},${r.period_start},${r.period_end})`).join(',\n');
    sql += ';\n\n';
  }
  sql += "notify pgrst, 'reload schema';\n";
  await writeFile(migration, sql);
  console.log(`Weekly climate complete: ${rows.length} rows. SQL: ${migration}`);
}
