import test from 'node:test';
import assert from 'node:assert/strict';
import { ORIGINS_ALL } from './origins.js';
import { DESTINATIONS } from './destinations.js';
import { ORIGIN_COORDS, DEST_COORDS } from './coords.js';
import { ORIGIN_REGIONS } from './origin-regions.js';
import { CITIES } from './cities.js';
import climateRows from '../../data/weather-climate.json' with { type: 'json' };

test('collector exposes AMS and LHR as fully configured origins', () => {
  assert.equal(ORIGINS_ALL.length, 22);
  assert.equal(new Set(ORIGINS_ALL).size, 22);
  for (const iata of ['AMS', 'LHR']) {
    assert.ok(ORIGINS_ALL.includes(iata), `${iata} missing from ORIGINS_ALL`);
    assert.ok(ORIGIN_COORDS[iata], `${iata} missing origin coordinates`);
    assert.ok(ORIGIN_REGIONS[iata], `${iata} missing origin region`);
  }
});

test('German domestic destinations are complete and unique', () => {
  const iatas = DESTINATIONS.map((destination) => destination.iata);
  assert.equal(iatas.length, 139);
  assert.equal(new Set(iatas).size, 139);
  for (const iata of ['BER', 'MUC', 'FRA', 'DUS', 'HAM', 'STR', 'CGN']) {
    assert.ok(iatas.includes(iata), `${iata} missing from destination catalogue`);
    assert.ok(DEST_COORDS[iata], `${iata} missing destination coordinates`);
    assert.ok(CITIES[iata], `${iata} missing photo-search metadata`);
    assert.ok(CITIES[iata].photoQuery, `${iata} missing curated primary photo query`);
    assert.ok(CITIES[iata].photoQueryFallbacks?.length >= 3, `${iata} needs at least three diverse photo fallbacks`);
    assert.equal(climateRows.filter((row) => row.iata === iata).length, 12, `${iata} climate must cover 12 months`);
  }
});
