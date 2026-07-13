// src/data/routes.js — hand-curated origin→destination route map (IATA codes).
//
// Hubs query every destination (see destinations.js); low-cost bases query only the
// narrow lists below. A rough approximation of real Ryanair/Wizz/Eurowings networks —
// Mediterranean-heavy (ES/IT/GR/HR/PT) plus Morocco and the Canaries, no long-haul.
export const AVAILABLE_ROUTES = {
  // Major hubs: wide network covering most/all destinations.
  'MUC': ['SPU', 'BCN', 'VLC', 'LIS', 'OPO', 'PMO', 'NCE', 'ATH', 'DBV', 'ALC', 'MAD', 'AGP', 'SVQ', 'VIE', 'ZRH', 'PRG', 'WAW', 'DUB', 'NAP', 'FCO', 'VCE', 'BLQ', 'BRQ', 'BUD'],
  'FRA': ['SPU', 'BCN', 'VLC', 'LIS', 'OPO', 'PMO', 'NCE', 'ATH', 'DBV', 'ALC', 'MAD', 'AGP', 'SVQ', 'VIE', 'ZRH', 'PRG', 'WAW', 'DUB', 'NAP', 'FCO', 'VCE', 'BLQ', 'BRQ', 'BUD', 'BER', 'DUS'],
  'BER': ['SPU', 'BCN', 'VLC', 'LIS', 'OPO', 'PMO', 'NCE', 'ATH', 'DBV', 'ALC', 'MAD', 'AGP', 'SVQ', 'VIE', 'ZRH', 'PRG', 'WAW', 'DUB', 'NAP', 'FCO', 'VCE', 'BLQ', 'BRQ', 'BUD'],
  'VIE': ['SPU', 'BCN', 'VLC', 'LIS', 'OPO', 'PMO', 'NCE', 'ATH', 'DBV', 'ALC', 'MAD', 'AGP', 'PRG', 'ZRH', 'BUD', 'BLQ', 'FCO', 'NAP'],
  'ZRH': ['SPU', 'BCN', 'VLC', 'LIS', 'OPO', 'PMO', 'NCE', 'ATH', 'DBV', 'MAD', 'AGP', 'FCO', 'VCE', 'NAP'],

  // Low-cost bases: narrow but real networks.
  'NUE': ['SPU', 'BCN', 'VLC', 'AGP', 'PMI', 'IBZ', 'LIS', 'OPO', 'FAO', 'PMO', 'NAP', 'CAG', 'ATH', 'HER', 'RHO', 'CFU', 'TFS', 'RAK', 'AYT', 'TIA'],
  'FMM': ['PMO', 'OPO', 'DBV', 'VLC', 'AGP', 'PMI', 'IBZ', 'FAO', 'NAP', 'CAG', 'ATH', 'RHO', 'CFU', 'TFS', 'RAK', 'TIA', 'SVQ'],
  'HHN': ['SPU', 'BCN', 'PMI', 'IBZ', 'AGP', 'VLC', 'FAO', 'OPO', 'PMO', 'NAP', 'CAG', 'ATH', 'RHO', 'CFU', 'HER', 'TFS', 'RAK', 'TIA'],
  'NRN': ['SPU', 'PMI', 'IBZ', 'AGP', 'VLC', 'FAO', 'OPO', 'PMO', 'NAP', 'CAG', 'ATH', 'RHO', 'CFU', 'TFS', 'RAK'],
};
