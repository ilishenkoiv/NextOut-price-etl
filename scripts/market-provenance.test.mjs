import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { checkTicket } from './check-flight-price-feedback.mjs';
import { buildTicketUrl } from './refresh-roulette-prices.mjs';
import { withPriceProvenance } from './price-provenance.mjs';

const read = (name) => readFileSync(new URL(name, import.meta.url), 'utf8');

test('all Travelpayouts collection paths send the origin market explicitly', async () => {
  const main = read('./fetch-prices.mjs');
  const windows = read('./fetch-window-prices.mjs');
  assert.match(main, /currency=eur&market=\$\{market\}&limit=500/);
  assert.match(main, /month=\$\{ym\}-01&market=\$\{market\}&show_to_affiliates=true/);
  assert.match(windows, /currency=eur&market=\$\{MARKET\}&limit=500/);

  const ticket = { origin:'BER', dest:'PMI', depart:'2027-01-10', ret:'2027-01-17', mode:'direct' };
  await checkTicket(ticket, { token:'secret', idle:async()=>true, fetchImpl:async(url) => {
    assert.equal(new URL(url).searchParams.get('market'), 'de');
    return { ok:true, json:async()=>({ success:true, data:[] }) };
  }});
  assert.equal(new URL(buildTicketUrl({
    origin:'AMS', dest:'PMI', departure_at:'2027-01-10', return_at:'2027-01-17', flight_type:'any',
  }, 'secret')).searchParams.get('market'), 'nl');
});

test('market is stored in price rows, snapshots and immutable provenance', () => {
  const main = read('./fetch-prices.mjs');
  const windows = read('./fetch-window-prices.mjs');
  const daily = read('./snapshot-daily-origin-cheapest.mjs');
  assert.match(main, /priceBuf\.push\(\{ origin, market,/);
  assert.match(main, /historyBuf\.push\(\{ origin, market,/);
  assert.match(main, /origin,market,dest,depart_month/);
  assert.match(windows, /origin: ORIGIN, market: MARKET/);
  assert.match(daily, /\.select\('origin,market,dest/);
  const [row] = withPriceProvenance([{ market:'ch', price:100 }], 'prices', {});
  assert.equal(row.price_source.market, 'ch');
});
