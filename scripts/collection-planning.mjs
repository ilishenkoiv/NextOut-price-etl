import { DESTINATIONS } from '../src/data/destinations.js';
import { ORIGINS_ALL } from '../src/data/origins.js';
import { expansionTargets } from '../src/data/expansion-targets.js';
import { isPriorityRoute, priorityWatchRouteKeys, PRIORITY_EXOTIC_DESTINATIONS } from './quote-integrity.mjs';
import { planWindowDestinations } from './window-destination-plan.mjs';

export const WINDOW_ORIGINS = ['BER','FRA','VIE','DUS','HAM','GVA','HHN','MUC','CGN','STR','ZRH','BTS','EIN','BSL','NRN','NUE','LEJ','FMM','DRS','SZG'];
export const catalogue = wave => [...DESTINATIONS, ...expansionTargets(wave)];
function watchKeys(rows,wave){
  return [...new Set([...priorityWatchRouteKeys(rows),...rows.filter(r=>r.watch_scope==='country').flatMap(r=>
    expansionTargets(wave).filter(d=>d.cc===r.country_code&&d.iata!==r.origin).map(d=>`${r.origin}|${d.iata}`))])];
}
export function horizon(date, count = 6) {
  const [year, month] = date.split('-').map(Number);
  return Array.from({ length: count }, (_, i) => new Date(Date.UTC(year, month + i, 1)).toISOString().slice(0, 7));
}
export function nextMonth(ym) { const [y,m] = ym.split('-').map(Number); return new Date(Date.UTC(y,m,1)).toISOString().slice(0,7); }

export function mainPlan({ date, wave, prices, watches }) {
  const months = horizon(date); const set = new Set(months);
  const seen = new Set(); const alive = new Set();
  for (const row of prices) if (set.has(row.month)) {
    const key = `${row.origin}|${row.dest}`; seen.add(key);
    if (Number(row.direct) > 0 || Number(row.any_stops) > 0) alive.add(key);
  }
  const priority = new Set(watchKeys(watches,wave));
  const live = []; const dead = [];
  for (const origin of ORIGINS_ALL) for (const d of catalogue(wave)) {
    if (origin === d.iata) continue;
    const route = { origin, dest: d.iata, stops: d.stops, key: `${origin}|${d.iata}` };
    (seen.has(route.key) && !alive.has(route.key) ? dead : live).push(route);
  }
  dead.sort((a,b) => a.key.localeCompare(b.key));
  const day = Math.floor(Date.parse(date) / 86400000);
  const routes = [...live, ...dead.filter((r,i) => i % 7 === day % 7 || isPriorityRoute(r, priority))];
  // Rotate deterministically to avoid losing the same origins after an outage.
  routes.sort((a,b) => a.key.localeCompare(b.key));
  const offset = routes.length ? day % routes.length : 0;
  return { months, routes: [...routes.slice(offset), ...routes.slice(0, offset)] };
}

export function tailPlan({ date, wave, windows, history, watches }) {
  const codes = catalogue(wave).map(d => d.iata);
  const activeWatchKeys = watchKeys(watches,wave);
  const routes = [];
  for (const origin of WINDOW_ORIGINS) {
    const findCount = new Map();
    for (const row of history) if (row.origin === origin) findCount.set(row.dest, (findCount.get(row.dest) ?? 0) + 1);
    const selected = planWindowDestinations({ allDests: codes.filter(d => d !== origin), findCount, planDate: date,
      topCount: 50, mode: 'auto', priorityDests: [...PRIORITY_EXOTIC_DESTINATIONS, ...activeWatchKeys.filter(k => k.startsWith(origin+'|')).map(k => k.split('|')[1])] }).selected;
    routes.push(...selected.map(dest => ({ origin, dest })));
  }
  return { routes, windows };
}

export function fastPlan({ rows, watches, today, limit = 10, wave = 0 }) {
  const priority = new Set(watchKeys(watches,wave));
  const allowed=new Set(catalogue(wave).map(d=>d.iata));
  const groups = new Map(WINDOW_ORIGINS.map(o => [o, new Map()]));
  for (const row of rows) {
    if (!groups.has(row.origin) || !allowed.has(row.dest) || row.dest===row.origin || row.departure_at < today || !row.return_at || row.return_at <= row.departure_at || !(Number(row.price) > 0)
      || !['weekend','holiday','weekend_around'].includes(row.window_kind)) continue;
    const key = [row.dest, row.departure_at, row.return_at].join('|');
    const group = groups.get(row.origin); const old = group.get(key);
    if (!old || row.price < old.price) group.set(key, row);
  }
  const candidates = [...groups.entries()].map(([origin, rows]) => {
    const sorted=[...rows.values()].sort((a,b)=>Number(priority.has(`${origin}|${b.dest}`))-Number(priority.has(`${origin}|${a.dest}`))||a.price-b.price);
    const cities=new Set();const first=[];const other=[];
    for(const row of sorted){if(cities.has(row.dest))other.push(row);else{cities.add(row.dest);first.push(row);}}
    return [...first,...other].slice(0,limit);
  });
  // Round-robin origins; no airport monopolizes a truncated fast slot.
  const tickets = [];
  for (let i = 0; i < limit; i++) for (const group of candidates) if (group[i]) {
    const r = group[i];
    for (const flight_type of ['direct','any']) tickets.push({ origin:r.origin,dest:r.dest,departure_at:r.departure_at,return_at:r.return_at,flight_type,
      nights:Math.round((Date.parse(r.return_at)-Date.parse(r.departure_at))/86400000),window_kind:r.window_kind });
  }
  return { tickets };
}
