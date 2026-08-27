// src/data/origin-regions.js — departure airport → country + state/canton.
//
// Maps each of the 22 collector origins (ORIGINS_ALL in origins.js) to the region whose public
// holidays decide a traveller's date windows. Subdivision codes are written EXACTLY as the holiday
// source (OpenHolidaysAPI) emits them — ISO 3166-2 for DE and CH, but German abbreviations for AT
// (AT-WI Vienna, AT-SB Salzburg — NOT the ISO AT-9 / AT-5). Verified live against
// https://openholidaysapi.org/Subdivisions on 2026-08-02.
//
// `subdivision` is the top-level state/canton (a "state"-level code). Holiday rows may also carry
// finer codes (e.g. DE-BY-AU for Augsburg), but an origin's home region is always a whole state.
//
// Three origins sit outside DACH physically and are assigned a DACH region by product decision
// (their catchment city), flagged with `physical`:
//   • BTS (Bratislava, SK) → collected by Vienna.
//   • EIN (Eindhoven, NL)  → collected by North Rhine-Westphalia.
//   • BSL (EuroAirport, on French soil) → treated as Basel-Stadt (CH).
export const ORIGIN_REGIONS = {
  // ── Germany hubs ────────────────────────────────────────────────────────────
  FRA: { country: 'DE', subdivision: 'DE-HE' }, // Hessen
  MUC: { country: 'DE', subdivision: 'DE-BY' }, // Bayern
  BER: { country: 'DE', subdivision: 'DE-BE' }, // Berlin
  DUS: { country: 'DE', subdivision: 'DE-NW' }, // Nordrhein-Westfalen
  HAM: { country: 'DE', subdivision: 'DE-HH' }, // Hamburg
  STR: { country: 'DE', subdivision: 'DE-BW' }, // Baden-Württemberg
  CGN: { country: 'DE', subdivision: 'DE-NW' }, // Nordrhein-Westfalen

  // ── Austria hubs ────────────────────────────────────────────────────────────
  VIE: { country: 'AT', subdivision: 'AT-WI' }, // Wien
  SZG: { country: 'AT', subdivision: 'AT-SB' }, // Salzburg

  // ── Switzerland hubs ────────────────────────────────────────────────────────
  ZRH: { country: 'CH', subdivision: 'CH-ZH' }, // Zürich
  GVA: { country: 'CH', subdivision: 'CH-GE' }, // Genève
  BSL: { country: 'CH', subdivision: 'CH-BS', physical: 'FR (EuroAirport, Saint-Louis) — treated as Basel-Stadt' },

  // ── International hubs added for their own local catchments ─────────────────
  AMS: { country: 'NL', subdivision: 'NL-NH' }, // Noord-Holland
  // OpenHolidaysAPI currently has no GB calendar rows; the code remains the honest physical
  // default and the app falls back to ordinary weekend windows until a GB source is added.
  LHR: { country: 'GB', subdivision: 'GB-ENG' }, // England

  // ── Germany low-cost bases ──────────────────────────────────────────────────
  NUE: { country: 'DE', subdivision: 'DE-BY' }, // Bayern
  FMM: { country: 'DE', subdivision: 'DE-BY' }, // Bayern (Memmingen)
  HHN: { country: 'DE', subdivision: 'DE-RP' }, // Rheinland-Pfalz (Frankfurt-Hahn)
  NRN: { country: 'DE', subdivision: 'DE-NW' }, // Nordrhein-Westfalen (Weeze)
  DRS: { country: 'DE', subdivision: 'DE-SN' }, // Sachsen (Dresden)
  LEJ: { country: 'DE', subdivision: 'DE-SN' }, // Sachsen (Leipzig/Halle — airport is in Schkeuditz, Saxony)

  // ── Outside DACH physically, assigned by catchment (product decision) ────────
  BTS: { country: 'AT', subdivision: 'AT-WI', physical: 'SK (Bratislava) — collected by Vienna' },
  EIN: { country: 'DE', subdivision: 'DE-NW', physical: 'NL (Eindhoven) — collected by North Rhine-Westphalia' },
};
