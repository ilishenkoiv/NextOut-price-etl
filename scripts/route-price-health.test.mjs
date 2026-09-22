import test from 'node:test';
import assert from 'node:assert/strict';
import { recordRouteAttempt, reviveRoute } from './route-price-health.mjs';
import { mainPlan } from './collection-planning.mjs';
import { DESTINATIONS } from '../src/data/destinations.js';

const DAY=86_400_000;
function emptyPass(state,day,passId,{expansion=false}={}){
  const horizon=['2026-10','2026-11','2026-12','2027-01','2027-02','2027-03'];
  for(const month of horizon)
    state=recordRouteAttempt(state,{outcome:'empty',at:day*DAY,passId,month,horizon,isExpansion:expansion});
  return state;
}

test('route is active at 29 days and dead only after a complete confirmed-empty pass at >=30 days',()=>{
  let s=emptyPass(null,0,1);
  s=emptyPass(s,29,2);assert.equal(s.status,'active');
  s=emptyPass(s,30,3);assert.equal(s.status,'dead');
});

test('network, 429 and missed attempts are not no-price evidence',()=>{
  let s=emptyPass(null,0,1);
  for(const outcome of ['network','429','missed'])s=recordRouteAttempt(s,{outcome,at:60*DAY,passId:2,month:'2026-10',horizon:[]});
  assert.equal(s.status,'active');assert.equal(s.firstConfirmedNoPriceAt,0);
});

test('a confirmed price immediately revives a dead route',()=>{
  let s=emptyPass(null,0,1);s=emptyPass(s,30,2);assert.equal(s.status,'dead');
  const horizon=['2026-10','2026-11','2026-12','2027-01','2027-02','2027-03'];
  s=recordRouteAttempt(s,{outcome:'price',at:31*DAY,passId:3,month:'2026-10',horizon});
  assert.equal(s.status,'active');assert.equal(s.firstConfirmedNoPriceAt,null);
});

test('exact-window/roulette positive writer uses the same immediate revival transition',()=>{
  let s=emptyPass(null,0,1);s=emptyPass(s,30,2);assert.equal(s.status,'dead');
  s=reviveRoute(s,{at:31*DAY});assert.equal(s.status,'active');assert.equal(s.firstConfirmedNoPriceAt,null);
});

test('duplicate month is idempotent; stale pass and changed horizon are rejected',()=>{
  const horizon=['2026-10','2026-11','2026-12','2027-01','2027-02','2027-03'];
  let s=recordRouteAttempt(null,{outcome:'empty',at:0,passId:5,month:horizon[0],horizon});
  s=recordRouteAttempt(s,{outcome:'empty',at:1,passId:5,month:horizon[0],horizon});assert.equal(s.observedMonths.length,1);
  assert.throws(()=>recordRouteAttempt(s,{outcome:'empty',at:2,passId:4,month:horizon[1],horizon}),/Stale/);
  assert.throws(()=>recordRouteAttempt(s,{outcome:'empty',at:2,passId:5,month:horizon[1],horizon:[...horizon.slice(0,5),'2027-04']}),/Horizon changed/);
});

test('new expansion route is protected for the full threshold and durable dead rows are sampled about 1/7',()=>{
  let s=emptyPass(null,0,1,{expansion:true});s=emptyPass(s,29,2,{expansion:true});assert.equal(s.status,'active');
  const date='2026-09-22';
  const health=DESTINATIONS.filter(d=>d.iata!=='FRA').slice(0,14).map(d=>({origin:'FRA',dest:d.iata,status:'dead'}));
  const plan=mainPlan({date,wave:0,prices:[],watches:[],routeHealth:health});
  const included=plan.routes.filter(r=>r.origin==='FRA'&&health.some(h=>h.dest===r.dest)).length;
  assert.ok(included<=2,'only the current 1/7 shard of durable dead routes is scheduled');
});
