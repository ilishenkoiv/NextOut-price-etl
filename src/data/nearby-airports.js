// src/data/nearby-airports.js — nearby alternative departure airports per origin.
//
// Powers the app's "nothing cheap from Munich? try Memmingen" hint: when a search from an
// origin finds little, the app can suggest a nearby low-cost airport with more Ryanair/Wizz
// routes. Keys are the departure airports (ORIGINS_ALL); values list nearby alternatives,
// nearest first. MOST origins have an empty array — the low-cost bases themselves ARE the
// alternatives, and several hubs have no budget satellite within reach.
//
// distanceKm is straight-line (approximate); transferHint is realistic public-transport time.
// Keep this file in sync with the copy in the private app repo (src/data/nearby-airports.ts).
export const NEARBY_AIRPORTS = {
  // ── Hubs with a nearby low-cost satellite ──────────────────────────────────
  FRA: [{ iata: 'HHN', name: 'Frankfurt-Hahn', distanceKm: 120, transferHint: '~1h45 by bus' }],
  MUC: [{ iata: 'FMM', name: 'Memmingen', distanceKm: 110, transferHint: '~1h40 by bus' }],
  DUS: [
    { iata: 'NRN', name: 'Weeze', distanceKm: 80, transferHint: '~1h15 by train+bus' },
    { iata: 'EIN', name: 'Eindhoven', distanceKm: 100, transferHint: '~1h45 by train' },
  ],
  CGN: [{ iata: 'HHN', name: 'Frankfurt-Hahn', distanceKm: 95, transferHint: '~1h30 by bus' }],
  ZRH: [{ iata: 'BSL', name: 'Basel', distanceKm: 85, transferHint: '~1h by train' }],
  VIE: [{ iata: 'BTS', name: 'Bratislava', distanceKm: 60, transferHint: '~1h by bus' }],

  // ── Hubs with no nearby low-cost airport in the dataset ─────────────────────
  BER: [],
  HAM: [],
  STR: [],
  GVA: [],
  BSL: [],
  SZG: [],

  // ── Low-cost bases: they ARE the alternatives, so no onward suggestion ───────
  NUE: [],
  FMM: [],
  HHN: [],
  NRN: [],
  BTS: [],
  EIN: [],
};
