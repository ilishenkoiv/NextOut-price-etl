// Canonical app place identity for the published legacy (snapshot wave 0) flight catalogue.
// Generated from Window 01 src/data/destinations.ts on 2026-09-22 and checked in so production
// selection never infers identity from display names. GVA/ZRH intentionally remain the legacy
// Chamonix/Zermatt identities until the shared-airport expansion contract is versioned.
export const DESTINATION_ID_BY_IATA=Object.freeze({
  ACE:'lanzarote',ADB:'izmir',AGA:'agadir',AGP:'malaga',ALA:'almaty',ALC:'alicante',AMS:'amsterdam',AQJ:'aqaba',
  ARN:'stockholm',ATH:'athens',AUH:'abudhabi',AYT:'antalya',BCN:'barcelona',BEG:'belgrade',BER:'berlin',BJV:'bodrum',
  BKK:'bangkok',BOJ:'burgas',BRN:'interlaken',BUD:'budapest',CAG:'sardinia',CAI:'cairo',CAN:'guangzhou',CDG:'paris',
  CFU:'corfu',CGN:'cologne',CHQ:'chania',CJU:'jeju',CMB:'colombo',CMN:'casablanca',CNX:'chiangmai',CPH:'copenhagen',
  CPT:'capetown',CTA:'catania',CTG:'cartagena',CTS:'sapporo',CUN:'cancun',DAD:'danang',DBV:'dubrovnik',DEL:'delhi',
  DJE:'djerba',DLM:'dalaman',DOH:'doha',DPS:'bali',DUB:'dublin',DUS:'dusseldorf',DXB:'dubai',EDI:'edinburgh',
  EZE:'buenosaires',FAO:'algarve',FCO:'rome',FLR:'florence',FNC:'madeira',FRA:'frankfurt',FUE:'fuerteventura',
  FUK:'fukuoka',GIG:'rio',GOI:'goa',GVA:'chamonix',HAM:'hamburg',HAN:'hanoi',HAV:'havana',HER:'crete',HKT:'phuket',
  HND:'tokyo',HNL:'hawaii',HRG:'hurghada',IBZ:'ibiza',ICN:'seoul',IST:'istanbul',JFK:'newyork',JTR:'santorini',
  KBV:'krabi',KEF:'reykjavik',KGS:'kos',KIX:'osaka',KRK:'krakow',KUL:'kualalumpur',LAX:'losangeles',LCA:'cyprus',
  LGK:'langkawi',LHR:'london',LIM:'lima',LIS:'lisbon',LJU:'ljubljana',LPA:'grancanaria',MCT:'muscat',MEX:'mexicocity',
  MIA:'miami',MLA:'malta',MLE:'maldives',MRS:'marseille',MRU:'mauritius',MUC:'munich',NAP:'naples',NBE:'hammamet',
  NBO:'nairobi',NCE:'nice',OPO:'porto',OTP:'bucharest',PEK:'beijing',PMI:'mallorca',PMO:'palermo',PRG:'prague',
  PUJ:'puntacana',PUS:'busan',PVG:'shanghai',RAK:'marrakech',RHO:'rhodes',RMF:'marsaalam',SCL:'santiago',
  SEZ:'seychelles',SFO:'sanfrancisco',SGN:'hochiminh',SIN:'singapore',SJJ:'sarajevo',SKG:'thessaloniki',SKP:'skopje',
  SOF:'sofia',SPU:'split',SSH:'sharm',STR:'stuttgart',SVQ:'seville',TAS:'tashkent',TBS:'tbilisi',TFS:'canaries',
  TFU:'chengdu',TIA:'tirana',TIV:'kotor',TLV:'telaviv',TNG:'tangier',VAR:'varna',VCE:'venice',VIE:'vienna',
  VLC:'valencia',YYZ:'toronto',ZAG:'zagreb',ZNZ:'zanzibar',ZRH:'zermatt',
});
export const destinationIdForIata=iata=>DESTINATION_ID_BY_IATA[iata]??null;
