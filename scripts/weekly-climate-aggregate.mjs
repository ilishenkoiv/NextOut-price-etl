// Pure aggregation for Copernicus ERA5 hourly samples → climate normals by ISO week.
// A "wet hour" is precipitation >= 0.1 mm. A wet day then separates into short shower
// (1–2 wet hours), changeable (3–5), or genuinely rainy (6+). Heavy day = >=10 mm.

const round = (value, digits = 1) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

export function isoWeek(dateYmd) {
  const [year, month, day] = dateYmd.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  const weekday = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - weekday);
  const isoYear = date.getUTCFullYear();
  const yearStart = new Date(Date.UTC(isoYear, 0, 1));
  return { year:isoYear, week:Math.ceil((((date - yearStart) / 86400000) + 1) / 7) };
}

export function dailyFromHourly(samples) {
  const byDay = new Map();
  for (const sample of samples) {
    const date = String(sample.time ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(sample.tempC)) continue;
    let day = byDay.get(date);
    if (!day) {
      day = { date, tmax:-Infinity, tmin:Infinity, precipMm:0, rainHours:0, sunHours:0, hours:0 };
      byDay.set(date, day);
    }
    day.tmax = Math.max(day.tmax, sample.tempC);
    day.tmin = Math.min(day.tmin, sample.tempC);
    const precip = Number.isFinite(sample.precipMm) ? Math.max(0, sample.precipMm) : 0;
    day.precipMm += precip;
    if (precip >= 0.1) day.rainHours += 1;
    if (Number.isFinite(sample.solarWm2) && sample.solarWm2 >= 120) day.sunHours += 1;
    day.hours += 1;
  }
  return [...byDay.values()].filter((day) => day.hours >= 18).map((day) => ({
    ...day,
    wet:day.precipMm >= 1,
    briefShower:day.precipMm >= 1 && day.rainHours <= 2,
    changeable:day.precipMm >= 1 && day.rainHours >= 3 && day.rainHours <= 5,
    rainy:day.precipMm >= 1 && day.rainHours >= 6,
    heavy:day.precipMm >= 10,
  }));
}

export function aggregateWeeklyNormalsFromDaily(dailyRows, periodStart = 1991, periodEnd = 2020) {
  const days = dailyRows.filter((day) => {
    const year = Number(day.date.slice(0, 4));
    return year >= periodStart && year <= periodEnd;
  });
  const weekInstances = new Map();
  for (const day of days) {
    const iso = isoWeek(day.date);
    const key = `${iso.year}-${iso.week}`;
    let instance = weekInstances.get(key);
    if (!instance) {
      instance = { isoWeek:iso.week, isoYear:iso.year, days:[] };
      weekInstances.set(key, instance);
    }
    instance.days.push(day);
  }
  const byWeek = new Map();
  for (const instance of weekInstances.values()) {
    if (instance.days.length < 4) continue; // ignore partial boundary fragments
    let list = byWeek.get(instance.isoWeek);
    if (!list) { list = []; byWeek.set(instance.isoWeek, list); }
    list.push(instance);
  }
  const rows = [];
  for (const [week, instances] of [...byWeek.entries()].sort((a, b) => a[0] - b[0])) {
    const allDays = instances.flatMap((item) => item.days);
    const wetDays = allDays.filter((day) => day.wet);
    const mean = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
    rows.push({
      iso_week:week,
      avg_tmax:round(mean(allDays.map((day) => day.tmax))),
      avg_tmin:round(mean(allDays.map((day) => day.tmin))),
      precip_mm:round(mean(instances.map((item) => item.days.reduce((sum, day) => sum + day.precipMm, 0)))),
      rain_days:round(mean(instances.map((item) => item.days.filter((day) => day.wet).length))),
      rain_probability:round(allDays.filter((day) => day.wet).length / allDays.length * 100),
      heavy_rain_probability:round(allDays.filter((day) => day.heavy).length / allDays.length * 100),
      brief_shower_probability:round(allDays.filter((day) => day.briefShower).length / allDays.length * 100),
      changeable_probability:round(allDays.filter((day) => day.changeable).length / allDays.length * 100),
      rainy_day_probability:round(allDays.filter((day) => day.rainy).length / allDays.length * 100),
      avg_rain_hours_wet_day:round(mean(wetDays.map((day) => day.rainHours))),
      avg_sun_h:round(mean(allDays.map((day) => day.sunHours))),
      sample_years:instances.length,
      period_start:periodStart,
      period_end:periodEnd,
    });
  }
  return rows;
}

export function aggregateWeeklyNormals(samples, periodStart = 1991, periodEnd = 2020) {
  return aggregateWeeklyNormalsFromDaily(dailyFromHourly(samples), periodStart, periodEnd);
}
