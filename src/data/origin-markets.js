// Aviasales/Travelpayouts market is the price-cache point of sale. It follows the departure
// airport used by NextOut and is deliberately independent from the holiday-calendar region.
// Keep this list in lockstep with the app's COUNTRY_TO_MARKET mapping in src/lib/config.ts.
export const ORIGIN_MARKETS = Object.freeze({
  FRA: 'de', MUC: 'de', BER: 'de', DUS: 'de', HAM: 'de', STR: 'de', CGN: 'de',
  NUE: 'de', FMM: 'de', HHN: 'de', NRN: 'de', DRS: 'de', LEJ: 'de',
  VIE: 'at', SZG: 'at',
  ZRH: 'ch', GVA: 'ch', BSL: 'ch',
  BTS: 'sk',
  AMS: 'nl', EIN: 'nl',
  LHR: 'gb',
});

export function marketForOrigin(origin) {
  const normalized = typeof origin === 'string' ? origin.trim().toUpperCase() : '';
  const market = ORIGIN_MARKETS[normalized];
  if (!market) throw new Error(`No Aviasales market configured for origin ${normalized || '(empty)'}.`);
  return market;
}
