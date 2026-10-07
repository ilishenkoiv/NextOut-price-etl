// src/data/origins.js — departure airports the collector queries.
//
// The collector now queries EVERY destination from EVERY origin (near = direct, long-haul
// = 1+ stop). The old hub/low-cost split — where low-cost bases only queried a narrow
// hand-curated map in routes.js — UNDER-collected exactly the cheap Ryanair/Wizz fares that
// matter most. Asking all 139 destinations from every origin (and letting the API return
// null where no route exists) is more honest than never asking.
//
// The two arrays below are now purely INFORMATIONAL (grouping / logging): both hubs and
// low-cost bases collect the full network identically. routes.js is kept for reference only.
export const HUB_AIRPORTS = ['FRA', 'MUC', 'BER', 'DUS', 'HAM', 'STR', 'CGN', 'VIE', 'ZRH', 'GVA', 'BSL', 'SZG', 'AMS', 'LHR'];
// Ryanair/Wizz/Eurowings/Transavia bases. BTS (Bratislava, 60 km from Vienna) and EIN
// (Eindhoven, ~100 km from Düsseldorf) added as major low-cost hubs near existing DACH cities.
// DRS (Dresden) and LEJ (Leipzig/Halle) are secondary Saxon airports served by Eurowings and
// Ryanair rather than network carriers — same profile as NUE/FMM, so they group here.
export const LOWCOST_AIRPORTS = ['NUE', 'FMM', 'HHN', 'NRN', 'BTS', 'EIN', 'DRS', 'LEJ'];
// Temporary departure-only suspension. Keep the catalogue and destination data intact.
// Re-enable only by a separately reviewed owner decision; never rewrite admitted plans.
export const SUSPENDED_DEPARTURES = Object.freeze(['AMS', 'LHR', 'EIN', 'BTS']);
export const isSuspendedOrigin = origin => SUSPENDED_DEPARTURES.includes(origin);
export const ORIGINS_CATALOGUE = [...HUB_AIRPORTS, ...LOWCOST_AIRPORTS];
export const ORIGINS_ALL = ORIGINS_CATALOGUE.filter(origin => !isSuspendedOrigin(origin));
