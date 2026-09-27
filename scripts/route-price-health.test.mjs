import test from 'node:test';
import assert from 'node:assert/strict';
import { recordRouteAttempt, reviveRoute, routeIsEffectivelyDead, TEMPORARY_DEAD_CUTOFF,
  TEMPORARY_DEAD_POLICY, PERMANENT_DEAD_POLICY } from './route-price-health.mjs';
import { mainPlan } from './collection-planning.mjs';
import { DESTINATIONS } from '../src/data/destinations.js';

const DAY=86_400_000;
function emptyPassAt(state,at,passId,{expansion=false}={}){
  const horizon=['2026-10','2026-11','2026-12','2027-01','2027-02','2027-03'];
  for(const month of horizon)
    state=recordRouteAttempt(state,{outcome:'empty',at,passId,month,horizon,isExpansion:expansion});
  return state;
}

test('permanent policy waits seven full days after complete confirmed-empty horizon evidence',()=>{
  const start=TEMPORARY_DEAD_CUTOFF+DAY;
  let s=emptyPassAt(null,start,1);
  s=emptyPassAt(s,start+7*DAY-1,2);assert.equal(s.status,'active');
  s=emptyPassAt(s,start+7*DAY,3);assert.equal(s.status,'dead');assert.equal(s.deadPolicy,PERMANENT_DEAD_POLICY);
});

test('temporary policy is immediate only before the exact Berlin cutoff; the cutoff instant uses seven-day policy',()=>{
  const temporary=emptyPassAt(null,TEMPORARY_DEAD_CUTOFF-1,1);
  assert.equal(temporary.status,'dead');assert.equal(temporary.deadPolicy,TEMPORARY_DEAD_POLICY);
  assert.equal(temporary.temporaryDeadUntil,TEMPORARY_DEAD_CUTOFF);
  const atCutoff=emptyPassAt(null,TEMPORARY_DEAD_CUTOFF,1);
  assert.equal(atCutoff.status,'active');assert.equal(atCutoff.deadPolicy,null);
});

test('network, 429 and missed attempts are not no-price evidence',()=>{
  const start=TEMPORARY_DEAD_CUTOFF+DAY;let s=emptyPassAt(null,start,1);
  for(const outcome of ['network','429','missed'])s=recordRouteAttempt(s,{outcome,at:start+60*DAY,passId:2,month:'2026-10',horizon:[]});
  assert.equal(s.status,'active');assert.equal(s.firstConfirmedNoPriceAt,start);
});

test('a confirmed price immediately revives a dead route',()=>{
  const start=TEMPORARY_DEAD_CUTOFF+DAY;let s=emptyPassAt(null,start,1);s=emptyPassAt(s,start+7*DAY,2);assert.equal(s.status,'dead');
  const horizon=['2026-10','2026-11','2026-12','2027-01','2027-02','2027-03'];
  s=recordRouteAttempt(s,{outcome:'price',at:start+8*DAY,passId:3,month:'2026-10',horizon});
  assert.equal(s.status,'active');assert.equal(s.firstConfirmedNoPriceAt,null);assert.equal(s.deadPolicy,null);
});

test('exact-window/roulette positive writer uses the same immediate revival transition',()=>{
  const start=TEMPORARY_DEAD_CUTOFF+DAY;let s=emptyPassAt(null,start,1);s=emptyPassAt(s,start+7*DAY,2);assert.equal(s.status,'dead');
  s=reviveRoute(s,{at:start+8*DAY});assert.equal(s.status,'active');assert.equal(s.firstConfirmedNoPriceAt,null);assert.equal(s.deadPolicy,null);
});

test('duplicate month is idempotent; stale pass and changed horizon are rejected',()=>{
  const horizon=['2026-10','2026-11','2026-12','2027-01','2027-02','2027-03'];
  let s=recordRouteAttempt(null,{outcome:'empty',at:0,passId:5,month:horizon[0],horizon});
  s=recordRouteAttempt(s,{outcome:'empty',at:1,passId:5,month:horizon[0],horizon});assert.equal(s.observedMonths.length,1);
  assert.throws(()=>recordRouteAttempt(s,{outcome:'empty',at:2,passId:4,month:horizon[1],horizon}),/Stale/);
  assert.throws(()=>recordRouteAttempt(s,{outcome:'empty',at:2,passId:5,month:horizon[1],horizon:[...horizon.slice(0,5),'2027-04']}),/Horizon changed/);
});

test('temporary immediate rule overrides expansion protection, then expiry restores protection until permanent eligibility',()=>{
  let s=emptyPassAt(null,TEMPORARY_DEAD_CUTOFF-1,1,{expansion:true});
  assert.equal(s.status,'dead');assert.equal(s.deadPolicy,TEMPORARY_DEAD_POLICY);
  const horizon=['2026-10','2026-11','2026-12','2027-01','2027-02','2027-03'];
  s=recordRouteAttempt(s,{outcome:'empty',at:TEMPORARY_DEAD_CUTOFF,passId:2,month:horizon[0],horizon,isExpansion:true});
  assert.equal(s.status,'active','expired temporary classification cannot bypass remaining expansion protection');
  s=emptyPassAt(s,TEMPORARY_DEAD_CUTOFF+30*DAY,3,{expansion:true});
  assert.equal(s.status,'dead');assert.equal(s.deadPolicy,PERMANENT_DEAD_POLICY);
});

test('an existing unprotected route gains the same expansion protection as the SQL transition',()=>{
  const start=TEMPORARY_DEAD_CUTOFF+DAY;
  let s=emptyPassAt(null,start,1);
  assert.equal(s.protectedUntil,null);
  s=emptyPassAt(s,start+7*DAY,2,{expansion:true});
  assert.equal(s.protectedUntil,start+30*DAY);
  assert.equal(s.status,'active','seven-day eligibility cannot bypass newly applied expansion protection');
});

test('expired temporary rows are operationally live and durable permanent dead rows are sampled about 1/7',()=>{
  const temporary={status:'dead',dead_policy:TEMPORARY_DEAD_POLICY,temporary_dead_until:'2026-09-28T22:00:00Z'};
  assert.equal(routeIsEffectivelyDead(temporary,TEMPORARY_DEAD_CUTOFF-1),true);
  assert.equal(routeIsEffectivelyDead(temporary,TEMPORARY_DEAD_CUTOFF),false);
  assert.equal(routeIsEffectivelyDead({status:'dead',dead_policy:TEMPORARY_DEAD_POLICY},TEMPORARY_DEAD_CUTOFF),false,
    'legacy/malformed temporary rows still expire at the global cutoff');
  const date='2026-09-22';
  const health=DESTINATIONS.filter(d=>d.iata!=='FRA').slice(0,14).map(d=>({origin:'FRA',dest:d.iata,status:'dead',dead_policy:PERMANENT_DEAD_POLICY}));
  const plan=mainPlan({date,wave:0,prices:[],watches:[],routeHealth:health});
  const included=plan.routes.filter(r=>r.origin==='FRA'&&health.some(h=>h.dest===r.dest)).length;
  assert.ok(included<=2,'only the current 1/7 shard of durable dead routes is scheduled');
});
