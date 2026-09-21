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

// ── Expansion tranche ────────────────────────────────────────────────────────────────────────
// Warming a newly added destination means collecting every (origin, month) cell for it. Because
// the main plan is alphabetically sorted and larger than a day's collection budget, a new
// destination's cells sit deep in the plan and are not reached for days. The tranche fixes this
// WITHOUT a parallel scheduler: it deterministically reorders the SAME main cells so a bounded,
// least-covered-first set of still-incomplete expansion destinations is collected first inside the
// normal `main` task. Total cells, route set, months and every downstream invariant are unchanged;
// once no expansion work remains, it is a no-op and normal main ordering resumes automatically.
//
// WHEN THE PRIORITY TAKES EFFECT: the reordering is baked into the durable per-pass plan
// (coordinator/main-<id>-<wave>.json) the first time that pass builds its plan. A main pass that
// was ALREADY in flight before this change — its durable plan has no cellOrder and its checkpoint
// has a non-zero cursor — keeps running in its original identity order to the end (its progress is
// never reset). The tranche therefore takes effect on the NEXT main pass, which builds a fresh
// durable plan. See collection-adapters.mjs main.step: cellOrder is honored only when present.
export const EXPANSION_TRANCHE_MAX_DESTS = 12;   // hard ceiling: ≤12 dests × 22 origins × 6 months = ≤1584 cells

// Parse and clamp the operator override EXPANSION_TRANCHE_DESTS to a safe integer in
// [0, EXPANSION_TRANCHE_MAX_DESTS]. Guarantees the advertised upper bound can never be exceeded:
//   undefined / null / '' / non-numeric → default (feature on at the ceiling; garbage never
//                                          silently disables OR unbounds expansion priority)
//   ≤ 0                                  → 0 (explicit disable)
//   fractional / oversized               → floored and clamped to the ceiling
export function resolveTrancheDests(value) {
  if (value === undefined || value === null || value === '') return EXPANSION_TRANCHE_MAX_DESTS;
  const n = Number(value);
  if (!Number.isFinite(n)) return EXPANSION_TRANCHE_MAX_DESTS;
  if (n <= 0) return 0;
  return Math.min(EXPANSION_TRANCHE_MAX_DESTS, Math.floor(n));
}

// Per-expansion-destination collection status for the current horizon, derived purely from the
// price rows already in the database. Only the REQUIRED cells count: each origin in ORIGINS_ALL
// (except the destination itself) × each horizon month. An extraneous origin (one not in
// ORIGINS_ALL) or an out-of-horizon month can never be counted toward — nor substitute for — a
// missing required cell. A destination is `complete` only once every required cell has been
// observed; such destinations are excluded from the tranche and never treated as new work.
export function expansionStatus({ date, wave, prices }) {
  const months = horizon(date);
  const monthSet = new Set(months);
  const targets = expansionTargets(wave);
  const destSet = new Set(targets.map(t => t.iata));
  const originSet = new Set(ORIGINS_ALL);
  const have = new Map();
  for (const row of prices) {
    if (!destSet.has(row.dest) || !originSet.has(row.origin) || row.origin === row.dest || !monthSet.has(row.month)) continue;
    let cells = have.get(row.dest); if (!cells) have.set(row.dest, cells = new Set());
    cells.add(row.origin + '|' + row.month);   // distinct REQUIRED (origin, month) cells only
  }
  return targets.map(t => {
    const expected = ORIGINS_ALL.filter(o => o !== t.iata).length * months.length;
    const got = have.get(t.iata)?.size ?? 0;
    return { iata: t.iata, priority: t.priority, expected, have: got, complete: expected > 0 && got >= expected };
  });
}

// Bounded, deterministic, least-covered-first selection of incomplete expansion destinations. The
// destinations with the LOWEST coverage ratio are always chosen first (deterministic tiebreak on
// priority then IATA). This makes progress on the minimum coverage monotone and starves no
// destination REGARDLESS of pass cadence, pass duration (a pass may span >24h), stops/resumes, or
// how the incomplete set changes between passes — it never relies on calendar-day rotation. A
// destination interrupted with partial coverage simply rejoins the front once others catch up or
// finish; complete destinations drop out, so the eligible set only shrinks and the tranche empties
// on its own once all are warm. `maxDests` is validated and clamped to the hard ceiling.
export function selectExpansionTranche({ date, wave, prices, maxDests = EXPANSION_TRANCHE_MAX_DESTS }) {
  const cap = resolveTrancheDests(maxDests);
  if (!Number(wave) || !cap) return [];
  const incomplete = expansionStatus({ date, wave, prices })
    .filter(s => !s.complete)
    .sort((a, b) => (a.have / a.expected) - (b.have / b.expected) || a.priority - b.priority || a.iata.localeCompare(b.iata));
  return incomplete.slice(0, Math.min(cap, incomplete.length)).map(s => s.iata);
}

// Produce a permutation of the main plan's cell ids (adapter convention: id = monthIndex*R + routeIndex)
// that front-loads all months of the tranche destinations, then keeps every remaining cell in the
// original month-major order. Returns null when there is no tranche, so the adapter falls back to the
// exact legacy identity ordering (zero regression when wave=0 or expansion is complete).
function expansionCellOrder({ date, wave, prices, months, routes, maxDests }) {
  const tranche = selectExpansionTranche({ date, wave, prices, maxDests });
  const R = routes.length, M = months.length;
  if (!tranche.length || !R || !M) return null;
  const total = R * M;
  const inHead = new Uint8Array(total);
  const order = [];
  for (const dest of tranche) for (let ri = 0; ri < R; ri++) if (routes[ri].dest === dest)
    for (let mi = 0; mi < M; mi++) { const id = mi * R + ri; order.push(id); inHead[id] = 1; }
  if (!order.length) return null;                       // tranche dests absent from the plan (defensive)
  for (let id = 0; id < total; id++) if (!inHead[id]) order.push(id);
  return { order, tranche };
}

export function mainPlan({ date, wave, prices, watches, trancheDests = EXPANSION_TRANCHE_MAX_DESTS }) {
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
  const ordered = [...routes.slice(offset), ...routes.slice(0, offset)];
  const plan = { months, routes: ordered };
  const tranche = expansionCellOrder({ date, wave, prices, months, routes: ordered, maxDests: trancheDests });
  if (tranche) { plan.cellOrder = tranche.order; plan.tranche = tranche.tranche; }
  return plan;
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
