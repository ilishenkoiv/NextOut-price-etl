// src/data/origins.js — departure airports the collector queries.
//
// HUB_AIRPORTS    — full-network hubs: the collector queries EVERY destination from
//                   them (near = direct, long-haul = 1+ stop).
// LOWCOST_AIRPORTS — Ryanair/Wizz/Eurowings bases with a narrow route map in routes.js;
//                   the collector only queries those routes.
export const HUB_AIRPORTS = ['FRA', 'MUC', 'BER', 'DUS', 'HAM', 'STR', 'CGN', 'VIE', 'ZRH', 'GVA', 'BSL', 'SZG'];
export const LOWCOST_AIRPORTS = ['NUE', 'FMM', 'HHN', 'NRN'];
export const ORIGINS_ALL = [...HUB_AIRPORTS, ...LOWCOST_AIRPORTS];
