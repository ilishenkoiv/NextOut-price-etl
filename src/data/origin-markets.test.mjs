import assert from 'node:assert/strict';
import test from 'node:test';
import { ORIGINS_ALL } from './origins.js';
import { marketForOrigin, ORIGIN_MARKETS } from './origin-markets.js';

test('every collected origin has one explicit lower-case Aviasales market', () => {
  assert.deepEqual(Object.keys(ORIGIN_MARKETS).sort(), [...ORIGINS_ALL].sort());
  for (const origin of ORIGINS_ALL) assert.match(marketForOrigin(origin), /^[a-z]{2}$/);
});

test('border and future origins use physical departure market, never holiday catchment', () => {
  assert.equal(marketForOrigin('BSL'), 'ch');
  assert.equal(marketForOrigin('BTS'), 'sk');
  assert.equal(marketForOrigin('EIN'), 'nl');
  assert.equal(marketForOrigin('AMS'), 'nl');
  assert.equal(marketForOrigin('LHR'), 'gb');
  assert.throws(() => marketForOrigin('XXX'), /No Aviasales market configured/);
});
