import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEST_COORDS } from '../src/data/coords.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const rows = JSON.parse(await readFile(path.join(root, 'data', 'weather-weekly-normals.json'), 'utf8'));
const resolved = JSON.parse(await readFile(path.join(root, 'data', 'copernicus-weekly', 'resolved-points.json'), 'utf8'));
const sql = await readFile(path.join(root, 'migrations', '20260901160000_weather_weekly_normals.sql'), 'utf8');
const fail = (message) => { throw new Error(message); };
const assert = (condition, message) => { if (!condition) fail(message); };

const expectedIatas = Object.keys(DEST_COORDS).sort();
const byIata = new Map();
for (const row of rows) {
  if (!byIata.has(row.iata)) byIata.set(row.iata, []);
  byIata.get(row.iata).push(row);
  for (const key of [
    'iso_week', 'avg_tmax', 'avg_tmin', 'precip_mm', 'rain_days', 'rain_probability',
    'heavy_rain_probability', 'brief_shower_probability', 'changeable_probability',
    'rainy_day_probability', 'avg_rain_hours_wet_day', 'avg_sun_h', 'sample_years',
    'period_start', 'period_end',
  ]) assert(Number.isFinite(row[key]), `${row.iata} week ${row.iso_week}: ${key} is not finite`);
  assert(row.period_start === 1991 && row.period_end === 2020, `${row.iata} week ${row.iso_week}: wrong period`);
  assert(row.iso_week >= 1 && row.iso_week <= 53, `${row.iata}: invalid ISO week`);
  assert(row.avg_tmax >= row.avg_tmin, `${row.iata} week ${row.iso_week}: Tmax below Tmin`);
  assert(row.rain_days >= 0 && row.rain_days <= 7, `${row.iata} week ${row.iso_week}: invalid rain days`);
  assert(row.avg_sun_h >= 0 && row.avg_sun_h <= 24, `${row.iata} week ${row.iso_week}: invalid sun hours`);
  assert(row.avg_rain_hours_wet_day >= 0 && row.avg_rain_hours_wet_day <= 24, `${row.iata} week ${row.iso_week}: invalid wet hours`);
  assert(row.precip_mm >= 0, `${row.iata} week ${row.iso_week}: negative precipitation`);
  for (const key of ['rain_probability', 'heavy_rain_probability', 'brief_shower_probability', 'changeable_probability', 'rainy_day_probability']) {
    assert(row[key] >= 0 && row[key] <= 100, `${row.iata} week ${row.iso_week}: invalid ${key}`);
  }
  assert(row.brief_shower_probability + row.changeable_probability + row.rainy_day_probability <= row.rain_probability + 0.2,
    `${row.iata} week ${row.iso_week}: duration classes exceed wet-day probability`);
  assert(row.sample_years >= 1 && row.sample_years <= 30, `${row.iata} week ${row.iso_week}: invalid sample years`);
}

assert(rows.length === 7367, `expected 7367 rows, got ${rows.length}`);
assert(byIata.size === 139, `expected 139 destinations, got ${byIata.size}`);
assert(JSON.stringify([...byIata.keys()].sort()) === JSON.stringify(expectedIatas), 'destination set differs from coords.js');
for (const iata of expectedIatas) {
  const weeks = byIata.get(iata).map((row) => row.iso_week).sort((a, b) => a - b);
  assert(weeks.length === 53, `${iata}: expected 53 weeks, got ${weeks.length}`);
  assert(weeks.every((week, index) => week === index + 1), `${iata}: missing or duplicate ISO week`);
}

const resolvedIatas = Object.values(resolved).flatMap((item) => item.iata).sort();
assert(JSON.stringify(resolvedIatas) === JSON.stringify(expectedIatas), 'resolved-points coverage differs from coords.js');
const globalEra5 = Object.values(resolved).filter((item) => item.dataset === 'reanalysis-era5-single-levels-timeseries').flatMap((item) => item.iata).sort();
const nearestLand = Object.values(resolved).filter((item) => item.dataset === 'reanalysis-era5-land-timeseries' &&
  (item.requested.latitude !== item.resolved.latitude || item.requested.longitude !== item.resolved.longitude)).flatMap((item) => item.iata).sort();

const sqlRows = (sql.match(/^\s*\('[A-Z]{3}',/gm) ?? []).length;
assert(sqlRows === rows.length, `SQL row count ${sqlRows} differs from JSON ${rows.length}`);
assert(sql.startsWith('-- Copernicus ERA5-Land weekly climate normals, 1991-2020.'), 'SQL attribution header missing');

const pick = (iata, week) => byIata.get(iata).find((row) => row.iso_week === week);
const sample = Object.fromEntries(['BER', 'PMI', 'MLE', 'SEZ'].flatMap((iata) => [
  [`${iata}-W03`, pick(iata, 3)],
  [`${iata}-W30`, pick(iata, 30)],
]));

console.log(JSON.stringify({
  rows: rows.length,
  destinations: byIata.size,
  weeksPerDestination: 53,
  period: '1991-2020',
  globalEra5,
  nearestLandCount: nearestLand.length,
  nearestLand,
  sqlRows,
  sample,
}, null, 2));
