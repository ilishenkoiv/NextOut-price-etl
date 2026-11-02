import test from 'node:test';
import assert from 'node:assert/strict';
import { carouselAlternate, carouselReplacementKey, isFreshConfirmed, replacementDecision, rouletteAlternate, selectedRefreshAdmission } from './selected-price-refresh-contract.mjs';
import { selectedPriceRefreshDue } from './priority-market-schedule.mjs';

const now=Date.parse('2026-10-31T12:00:00Z');
const fresh={origin:'FRA',flight_type:'any',dest:'MAD',departure_at:'2027-02-10',return_at:'2027-02-14',price:99,updated_at:new Date(now-60_000).toISOString()};

test('eligible Berlin half-hour cadence is bounded and DST-safe through Intl',()=>{
  assert.equal(selectedPriceRefreshDue(Date.parse('2026-06-01T06:00:00Z'),true),true); // 08:00 CEST
  assert.equal(selectedPriceRefreshDue(Date.parse('2026-12-01T06:30:00Z'),true),false); // 07:30 CET
  assert.equal(selectedPriceRefreshDue(Date.parse('2026-12-01T21:30:00Z'),true),true); // 22:30 CET
  assert.equal(selectedPriceRefreshDue(Date.parse('2026-12-01T22:00:00Z'),true),false);
});

test('fresh equal price holds and technical or unconfirmed outcomes are no-ops',()=>{
  assert.equal(isFreshConfirmed(fresh,now),true);
  assert.deepEqual(replacementDecision('roulette','fresh',fresh),{outcome:'retain_fresh',replacement:null});
  assert.deepEqual(replacementDecision('carousel','timeout',fresh),{outcome:'retain_unconfirmed',replacement:null});
});

test('confirmed absence selects server-only roulette alternate and exact-date carousel alternate',()=>{
  const rows=[fresh,{...fresh,dest:'LIS',price:88,departure_at:'2027-03-01',return_at:'2027-03-06'}];
  assert.equal(rouletteAlternate(rows,{...fresh,dest:'FCO'},now,new Set(['FCO'])).dest,'LIS');
  assert.equal(carouselAlternate(rows,{...fresh,dest:'FCO'},now).dest,'MAD');
  assert.deepEqual(replacementDecision('carousel','confirmed_absent',fresh),{outcome:'replaced',replacement:fresh});
});

test('durable OFF and MAIN rollback reject admission; stale candidates are rejected',()=>{
  assert.deepEqual(selectedRefreshAdmission({enabled:false,generation:2,main12h_rollback:false},now),{active:false,generation:null});
  assert.deepEqual(selectedRefreshAdmission({enabled:true,generation:2,main12h_rollback:true},now),{active:false,generation:null});
  assert.equal(isFreshConfirmed({...fresh,updated_at:new Date(now-31*60_000).toISOString()},now),false);
});

test('exact carousel key includes the original candidate identity',()=>{
  assert.equal(carouselReplacementKey({epoch:'e',origin:'MUC',flightType:'any',windowKind:'holiday',departureAt:'2026-11-01',returnAt:'2026-11-04',originalCandidateId:'rome'}),'e|MUC|any|holiday|2026-11-01|2026-11-04|rome');
});
