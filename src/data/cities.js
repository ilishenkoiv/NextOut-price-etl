// src/data/cities.js — IATA → { city, country, photoQuery? } for the 125 destinations.
//
// Used ONLY by the one-off photo-curation scripts (scripts/fetch-photos.mjs etc.), NOT by
// the price collector. Country names are the authoritative full names from the app repo's
// src/lib/countries.ts (COUNTRY_NAME_BY_IATA). City names are the human display names.
//
// `photoQuery` (optional) overrides the Pexels search string for that city. Use it when the
// display city is a poor photo query: an airport name rather than the town people photograph
// (DLM→Oludeniz, TIV→Kotor), or a name that duplicates the country (MLE/SEZ/MLA/SIN) or is
// too generic (DPS "Bali"). When absent, the search string is `"{city} {country}"`.
//
//   getPhotoQuery(iata) → the exact string sent to Pexels ?query=
export const CITIES = {
  // ── Croatia
  // "Split" is an English verb → Pexels mixes in unrelated shots; steer + provide fallbacks.
  SPU: {
    city: 'Split',
    country: 'Croatia',
    photoQuery: 'Split Croatia old town',
    photoQueryFallbacks: ['Diocletian Palace Split', 'Split Dalmatia Croatia', 'Split harbour Croatia'],
  },
  DBV: { city: 'Dubrovnik', country: 'Croatia' },
  ZAG: { city: 'Zagreb', country: 'Croatia' },

  // ── Spain (mainland, Balearics, Canaries)
  BCN: { city: 'Barcelona', country: 'Spain' },
  VLC: { city: 'Valencia', country: 'Spain' },
  AGP: { city: 'Málaga', country: 'Spain' },
  SVQ: { city: 'Seville', country: 'Spain' },
  ALC: { city: 'Alicante', country: 'Spain' },
  PMI: { city: 'Palma de Mallorca', country: 'Spain' },
  IBZ: { city: 'Ibiza', country: 'Spain' },
  TFS: { city: 'Tenerife', country: 'Spain' },
  LPA: { city: 'Gran Canaria', country: 'Spain' }, // recognizable island name — keep as-is
  ACE: { city: 'Lanzarote', country: 'Spain' },    // recognizable island name — keep as-is
  FUE: { city: 'Fuerteventura', country: 'Spain' },// recognizable island name — keep as-is

  // ── Portugal
  LIS: { city: 'Lisbon', country: 'Portugal' },
  OPO: { city: 'Porto', country: 'Portugal' },
  FAO: { city: 'Faro', country: 'Portugal' },
  FNC: { city: 'Madeira', country: 'Portugal', photoQuery: 'Funchal Madeira' },

  // ── Italy
  FCO: { city: 'Rome', country: 'Italy' },
  NAP: { city: 'Naples', country: 'Italy' },
  PMO: { city: 'Palermo', country: 'Italy' },
  CTA: { city: 'Catania', country: 'Italy' },
  CAG: { city: 'Cagliari', country: 'Italy' },
  VCE: { city: 'Venice', country: 'Italy' },
  FLR: { city: 'Florence', country: 'Italy' },

  // ── Greece
  ATH: { city: 'Athens', country: 'Greece' },
  SKG: { city: 'Thessaloniki', country: 'Greece' },
  HER: { city: 'Heraklion', country: 'Greece', photoQuery: 'Crete Greece' },
  CHQ: { city: 'Chania', country: 'Greece' },
  JTR: { city: 'Santorini', country: 'Greece' },
  RHO: { city: 'Rhodes', country: 'Greece' },
  KGS: { city: 'Kos', country: 'Greece', photoQuery: 'Kos island Greece' },
  CFU: { city: 'Corfu', country: 'Greece' },

  // ── France
  NCE: { city: 'Nice', country: 'France' },
  MRS: { city: 'Marseille', country: 'France' },
  CDG: { city: 'Paris', country: 'France' },

  // ── Malta / Cyprus
  MLA: { city: 'Malta', country: 'Malta', photoQuery: 'Valletta Malta' },
  LCA: { city: 'Larnaca', country: 'Cyprus' },

  // ── Turkey
  AYT: { city: 'Antalya', country: 'Turkey' },
  IST: { city: 'Istanbul', country: 'Turkey' },
  ADB: { city: 'Izmir', country: 'Turkey' },
  BJV: { city: 'Bodrum', country: 'Turkey' },
  DLM: { city: 'Dalaman', country: 'Turkey', photoQuery: 'Oludeniz Turkey' }, // airport → photograph Oludeniz

  // ── Balkans
  TIA: { city: 'Tirana', country: 'Albania' },
  TIV: { city: 'Tivat', country: 'Montenegro', photoQuery: 'Kotor Montenegro' }, // Kotor is more photogenic
  BEG: { city: 'Belgrade', country: 'Serbia' },
  SJJ: { city: 'Sarajevo', country: 'Bosnia and Herzegovina' },
  SKP: { city: 'Skopje', country: 'North Macedonia' },
  OTP: { city: 'Bucharest', country: 'Romania' },
  LJU: { city: 'Ljubljana', country: 'Slovenia' },

  // ── Bulgaria
  SOF: { city: 'Sofia', country: 'Bulgaria' },
  BOJ: { city: 'Burgas', country: 'Bulgaria' },
  VAR: { city: 'Varna', country: 'Bulgaria' },

  // ── Western / Central / Northern Europe
  LHR: { city: 'London', country: 'United Kingdom' },
  EDI: { city: 'Edinburgh', country: 'United Kingdom' },
  DUB: { city: 'Dublin', country: 'Ireland' },
  AMS: { city: 'Amsterdam', country: 'Netherlands' },
  VIE: { city: 'Vienna', country: 'Austria' },
  PRG: { city: 'Prague', country: 'Czechia' },
  BUD: { city: 'Budapest', country: 'Hungary' },
  KRK: { city: 'Krakow', country: 'Poland' },
  CPH: { city: 'Copenhagen', country: 'Denmark' },
  ARN: { city: 'Stockholm', country: 'Sweden' },
  KEF: { city: 'Reykjavik', country: 'Iceland' },
  GVA: { city: 'Geneva', country: 'Switzerland' },
  ZRH: { city: 'Zurich', country: 'Switzerland' },
  BRN: { city: 'Bern', country: 'Switzerland' },

  // ── Middle East
  DXB: { city: 'Dubai', country: 'United Arab Emirates' },
  AUH: { city: 'Abu Dhabi', country: 'United Arab Emirates' },
  DOH: { city: 'Doha', country: 'Qatar' },
  MCT: { city: 'Muscat', country: 'Oman' },
  AQJ: { city: 'Aqaba', country: 'Jordan' },
  TLV: { city: 'Tel Aviv', country: 'Israel' },

  // ── North Africa
  RAK: { city: 'Marrakesh', country: 'Morocco' },
  AGA: { city: 'Agadir', country: 'Morocco' },
  CMN: { city: 'Casablanca', country: 'Morocco' },
  TNG: { city: 'Tangier', country: 'Morocco' },
  DJE: { city: 'Djerba', country: 'Tunisia' },
  NBE: { city: 'Hammamet', country: 'Tunisia', photoQuery: 'Hammamet Tunisia' }, // airport is Enfidha
  CAI: { city: 'Cairo', country: 'Egypt' },
  HRG: { city: 'Hurghada', country: 'Egypt' },
  SSH: { city: 'Sharm El Sheikh', country: 'Egypt' },
  RMF: { city: 'Marsa Alam', country: 'Egypt' },

  // ── Sub-Saharan Africa & Indian Ocean
  ZNZ: { city: 'Zanzibar', country: 'Tanzania', photoQuery: 'Zanzibar beach' },
  NBO: { city: 'Nairobi', country: 'Kenya' },
  CPT: { city: 'Cape Town', country: 'South Africa' },
  MRU: { city: 'Mauritius', country: 'Mauritius', photoQuery: 'Mauritius beach' },
  SEZ: {
    city: 'Seychelles',
    country: 'Seychelles',
    photoQuery: 'Seychelles beach', // many candidates are posed models → fall back to named beaches
    photoQueryFallbacks: ['La Digue Seychelles', 'Anse Source d Argent beach', 'Praslin Seychelles beach'],
  },

  // ── Caucasus & Central Asia
  TBS: { city: 'Tbilisi', country: 'Georgia' },
  TAS: { city: 'Tashkent', country: 'Uzbekistan' },
  ALA: { city: 'Almaty', country: 'Kazakhstan' },

  // ── Asia
  BKK: { city: 'Bangkok', country: 'Thailand' },
  HKT: { city: 'Phuket', country: 'Thailand' },
  KBV: { city: 'Krabi', country: 'Thailand' },
  CNX: { city: 'Chiang Mai', country: 'Thailand' },
  DPS: { city: 'Bali', country: 'Indonesia', photoQuery: 'Bali Indonesia' }, // not "Denpasar"
  SIN: { city: 'Singapore', country: 'Singapore', photoQuery: 'Singapore skyline' }, // city == country
  KUL: { city: 'Kuala Lumpur', country: 'Malaysia' },
  LGK: { city: 'Langkawi', country: 'Malaysia' },
  HAN: { city: 'Hanoi', country: 'Vietnam' },
  SGN: { city: 'Ho Chi Minh City', country: 'Vietnam' },
  DAD: { city: 'Da Nang', country: 'Vietnam' },
  HND: {
    city: 'Tokyo', country: 'Japan',
    photoQuery: 'Tokyo Tower Japan',
    photoQueryFallbacks: ['Shibuya crossing Tokyo', 'Senso-ji temple Tokyo'],
  },
  KIX: {
    city: 'Osaka', country: 'Japan',
    photoQuery: 'Osaka Castle Japan',
    photoQueryFallbacks: ['Dotonbori Osaka night', 'Osaka skyline Japan'],
  },
  ICN: {
    city: 'Seoul', country: 'South Korea',
    photoQuery: 'Gyeongbokgung Palace Seoul',
    photoQueryFallbacks: ['N Seoul Tower night', 'Bukchon Hanok Village Seoul'],
  },
  // ── East Asia expansion (2026-07-18). Tokyo is HND only — NRT was a duplicate entry
  // for the same city and was dropped (2026-07-21); the app's catalog keys Tokyo on HND.
  PEK: {
    city: 'Beijing', country: 'China',
    photoQuery: 'Great Wall of China',
    photoQueryFallbacks: ['Forbidden City Beijing', 'Beijing skyline CBD'],
  },
  PVG: {
    city: 'Shanghai', country: 'China',
    photoQuery: 'Shanghai Pudong skyline',
    photoQueryFallbacks: ['Shanghai Yuyuan garden', 'Shanghai French Concession street', 'Shanghai night cityscape'],
  },
  CAN: {
    city: 'Guangzhou', country: 'China',
    photoQuery: 'Canton Tower Guangzhou',
    photoQueryFallbacks: ['Guangzhou Pearl River night', 'Shamian Island Guangzhou'],
  },
  TFU: {
    city: 'Chengdu', country: 'China',
    photoQuery: 'Chengdu skyline',
    photoQueryFallbacks: ['Chengdu Anshun bridge', 'Chengdu Jinli ancient street', 'Chengdu teahouse people', 'Giant panda Chengdu'],
  },
  CTS: {
    city: 'Sapporo', country: 'Japan',
    photoQuery: 'Sapporo snow festival',
    photoQueryFallbacks: ['Odori Park Sapporo winter', 'Sapporo cityscape Hokkaido'],
  },
  FUK: {
    city: 'Fukuoka', country: 'Japan',
    photoQuery: 'Fukuoka skyline',
    photoQueryFallbacks: ['Fukuoka Ohori park', 'Fukuoka Canal City', 'Fukuoka temple', 'Fukuoka yatai food stalls'],
  },
  PUS: {
    city: 'Busan', country: 'South Korea',
    photoQuery: 'Gamcheon Culture Village Busan',
    photoQueryFallbacks: ['Haeundae beach Busan', 'Busan Gwangan bridge night'],
  },
  CJU: {
    city: 'Jeju', country: 'South Korea',
    photoQuery: 'Seongsan Ilchulbong Jeju',
    photoQueryFallbacks: ['Jeju island coast South Korea', 'Hallasan Jeju island'],
  },
  CMB: { city: 'Colombo', country: 'Sri Lanka' },
  GOI: { city: 'Goa', country: 'India' },
  DEL: { city: 'Delhi', country: 'India' },
  MLE: { city: 'Maldives', country: 'Maldives', photoQuery: 'Maldives beach' }, // city == country

  // ── North America
  JFK: { city: 'New York', country: 'United States' },
  MIA: { city: 'Miami', country: 'United States' },
  LAX: { city: 'Los Angeles', country: 'United States' },
  SFO: { city: 'San Francisco', country: 'United States' },
  HNL: { city: 'Honolulu', country: 'United States', photoQuery: 'Honolulu Hawaii' },
  YYZ: { city: 'Toronto', country: 'Canada' },

  // ── Caribbean / Central America
  CUN: { city: 'Cancun', country: 'Mexico' },
  MEX: { city: 'Mexico City', country: 'Mexico' },
  HAV: { city: 'Havana', country: 'Cuba' },
  PUJ: { city: 'Punta Cana', country: 'Dominican Republic' },

  // ── South America
  GIG: { city: 'Rio de Janeiro', country: 'Brazil' },
  EZE: { city: 'Buenos Aires', country: 'Argentina' },
  LIM: { city: 'Lima', country: 'Peru' },
  CTG: { city: 'Cartagena', country: 'Colombia' },
  SCL: { city: 'Santiago', country: 'Chile' },
};

/** The primary string sent to Pexels ?query= for an IATA: photoQuery if set, else "city country". */
export function getPhotoQuery(iata) {
  const c = CITIES[iata];
  if (!c) return null;
  return c.photoQuery || `${c.city} ${c.country}`;
}

/**
 * Ordered search strings for an IATA: the primary query first, then any photoQueryFallbacks.
 * fetch-photos tries the next one ONLY when a city comes up short (< MIN_RESULTS candidates),
 * so any problem city can be fixed by adding photoQueryFallbacks in this file — no script edit.
 */
export function getPhotoQueries(iata) {
  const primary = getPhotoQuery(iata);
  if (primary == null) return [];
  const fallbacks = CITIES[iata]?.photoQueryFallbacks || [];
  return [primary, ...fallbacks];
}
