import assert from 'node:assert/strict';
import test from 'node:test';
import { aggregateWeeklyNormals, dailyFromHourly, isoWeek } from './weekly-climate-aggregate.mjs';

const day = (date, rainHours, precipMm, temp = 20, sunHours = 6) => Array.from({ length:24 }, (_, hour) => ({
  time:`${date}T${String(hour).padStart(2,'0')}:00`,
  tempC:temp + (hour >= 12 && hour <= 15 ? 5 : 0),
  precipMm:hour < rainHours ? precipMm / Math.max(1, rainHours) : 0,
  solarWm2:hour >= 8 && hour < 8 + sunHours ? 200 : 0,
}));

test('ISO week handles the year boundary', () => {
  assert.deepEqual(isoWeek('2021-01-01'), { year:2020, week:53 });
  assert.deepEqual(isoWeek('2021-01-04'), { year:2021, week:1 });
});

test('daily classification distinguishes a shower from an all-day rain', () => {
  const rows = dailyFromHourly([
    ...day('2019-01-07',1,2),
    ...day('2019-01-08',7,12),
  ]);
  assert.equal(rows[0].briefShower,true);
  assert.equal(rows[0].rainy,false);
  assert.equal(rows[1].briefShower,false);
  assert.equal(rows[1].rainy,true);
  assert.equal(rows[1].heavy,true);
});

test('weekly normals preserve precipitation duration probabilities', () => {
  const samples = [];
  for (const year of [2019,2020]) {
    const start = year === 2019 ? 7 : 6;
    for (let offset=0; offset<7; offset++) {
      const date = new Date(Date.UTC(year,0,start+offset)).toISOString().slice(0,10);
      samples.push(...day(date, offset===0?1:offset===1?7:0, offset===0?2:offset===1?12:0));
    }
  }
  const week2 = aggregateWeeklyNormals(samples,2019,2020).find((row) => row.iso_week===2);
  assert.ok(week2);
  assert.equal(week2.rain_days,2);
  assert.equal(week2.brief_shower_probability,14.3);
  assert.equal(week2.rainy_day_probability,14.3);
  assert.equal(week2.heavy_rain_probability,14.3);
  assert.equal(week2.avg_rain_hours_wet_day,4);
  assert.equal(week2.precip_mm,14);
});
