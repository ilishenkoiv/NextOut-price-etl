// src/data/routes.js — hand-curated origin→destination route map (IATA codes).
//
// ⚠️ REFERENCE ONLY — no longer read by the collector. As of the low-cost coverage
// expansion, fetch-prices.mjs queries EVERY destination from every origin (see
// origins.js / targetsFor). This map is kept because it documents the real, approximate
// Ryanair/Wizz/Eurowings low-cost networks (Mediterranean-heavy: ES/IT/GR/HR/PT plus
// Morocco and the Canaries, no long-haul) and may be useful for future ranking hints.
export const AVAILABLE_ROUTES = {
  // Major hubs: wide network covering most/all destinations.
  'MUC': ['SPU', 'BCN', 'VLC', 'LIS', 'OPO', 'PMO', 'NCE', 'ATH', 'DBV', 'ALC', 'MAD', 'AGP', 'SVQ', 'VIE', 'ZRH', 'PRG', 'WAW', 'DUB', 'NAP', 'FCO', 'VCE', 'BLQ', 'BRQ', 'BUD', 'BER', 'FRA', 'DUS', 'HAM', 'STR', 'CGN'],
  'FRA': ['SPU', 'BCN', 'VLC', 'LIS', 'OPO', 'PMO', 'NCE', 'ATH', 'DBV', 'ALC', 'MAD', 'AGP', 'SVQ', 'VIE', 'ZRH', 'PRG', 'WAW', 'DUB', 'NAP', 'FCO', 'VCE', 'BLQ', 'BRQ', 'BUD', 'BER', 'MUC', 'DUS', 'HAM', 'STR', 'CGN'],
  'BER': ['SPU', 'BCN', 'VLC', 'LIS', 'OPO', 'PMO', 'NCE', 'ATH', 'DBV', 'ALC', 'MAD', 'AGP', 'SVQ', 'VIE', 'ZRH', 'PRG', 'WAW', 'DUB', 'NAP', 'FCO', 'VCE', 'BLQ', 'BRQ', 'BUD', 'MUC', 'FRA', 'DUS', 'HAM', 'STR', 'CGN'],
  'DUS': ['BER', 'MUC', 'FRA', 'HAM', 'STR'],
  'HAM': ['BER', 'MUC', 'FRA', 'DUS', 'STR', 'CGN'],
  'STR': ['BER', 'MUC', 'FRA', 'DUS', 'HAM'],
  'CGN': ['BER', 'MUC', 'HAM'],
  'VIE': ['SPU', 'BCN', 'VLC', 'LIS', 'OPO', 'PMO', 'NCE', 'ATH', 'DBV', 'ALC', 'MAD', 'AGP', 'PRG', 'ZRH', 'BUD', 'BLQ', 'FCO', 'NAP'],
  'ZRH': ['SPU', 'BCN', 'VLC', 'LIS', 'OPO', 'PMO', 'NCE', 'ATH', 'DBV', 'MAD', 'AGP', 'FCO', 'VCE', 'NAP'],

  // Low-cost bases: narrow but real networks.
  'NUE': ['SPU', 'BCN', 'VLC', 'AGP', 'PMI', 'IBZ', 'LIS', 'OPO', 'FAO', 'PMO', 'NAP', 'CAG', 'ATH', 'HER', 'RHO', 'CFU', 'TFS', 'RAK', 'AYT', 'TIA'],
  'FMM': ['PMO', 'OPO', 'DBV', 'VLC', 'AGP', 'PMI', 'IBZ', 'FAO', 'NAP', 'CAG', 'ATH', 'RHO', 'CFU', 'TFS', 'RAK', 'TIA', 'SVQ'],
  'HHN': ['SPU', 'BCN', 'PMI', 'IBZ', 'AGP', 'VLC', 'FAO', 'OPO', 'PMO', 'NAP', 'CAG', 'ATH', 'RHO', 'CFU', 'HER', 'TFS', 'RAK', 'TIA'],
  'NRN': ['SPU', 'PMI', 'IBZ', 'AGP', 'VLC', 'FAO', 'OPO', 'PMO', 'NAP', 'CAG', 'ATH', 'RHO', 'CFU', 'TFS', 'RAK'],
};
