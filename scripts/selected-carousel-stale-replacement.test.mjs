import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from './collection-adapters.mjs';

function chain(data){return new Proxy({}, {get:(_,key)=>key==='then'
  ?Promise.resolve({data,error:null}).then.bind(Promise.resolve({data,error:null}))
  :()=>chain(data)});}

const now=Date.parse('2026-11-12T09:00:00Z');
const snapshot='2026-11-12T03:30:00Z';
const stale=minutes=>new Date(now-minutes*60_000).toISOString();

async function selected({flightType,offers=[],revisionCandidates=[],response}){
  const before=process.env.SELECTED_PRICE_REFRESH_CANDIDATE;
  process.env.SELECTED_PRICE_REFRESH_CANDIDATE='owner-manual';
  try{
    const ticket={observed_on:'2026-11-12',snapshot_at:snapshot,origin:'FRA',dest:'FCO',destination_id:'rome',
      flight_type:flightType,departure_at:'2026-11-20',return_at:'2026-11-22',position:1,window_kind:'weekend',
      exact_observed_at:stale(31),updated_at:stale(31)};
    const commits=[];
    const rows={selected_price_refresh_control:[{enabled:true,generation:7,main12h_rollback:false}],
      daily_window_candidate_epochs:[{observed_on:'2026-11-12',snapshot_at:snapshot,contract_version:1,candidate_rows:1,exact_request_groups:1}],offers,
      daily_origin_window_candidate_revisions:revisionCandidates.length?[{observed_on:'2026-11-12',origin:'FRA',revision:1,snapshot_at:'2026-11-12T09:00:00Z'}]:[],
      daily_origin_window_candidate_revision_candidates:revisionCandidates};
    const db={from:table=>chain(rows[table]??[]),rpc:(name,args)=>{commits.push({name,args});return Promise.resolve({data:true,error:null});},storage:{from:()=>({})}};
    const store={args:()=>({p_owner:'test-owner',p_token:1}),lease:async()=>true,runId:'test',
      plan:async()=>({day:'2026-11-12',setId:'daily-window:test',selectedAt:snapshot,tickets:[ticket],groups:[[ticket]]})};
    const result=await createAdapters({db,store,provider:{request:async()=>response},clock:()=>now}).priority.step({job:{id:1,planDate:'2026-11-12',
      checkpoint:{cycle:1,dueAt:now,phase:'weekend',auditDone:true,roulette:{done:true}}},deadline:now+200_000});
    assert.equal(result.checkpoint.weekend.errors,0);
    assert.equal(commits.length,1);
    assert.equal(commits[0].name,'collection_commit_selected_carousel');
    return commits[0].args.p_result;
  }finally{
    if(before===undefined)delete process.env.SELECTED_PRICE_REFRESH_CANDIDATE;else process.env.SELECTED_PRICE_REFRESH_CANDIDATE=before;
  }
}

function offer(dest,flight_type,minutes,price){return {origin:'FRA',dest,flight_type,departure_at:'2026-11-20',return_at:'2026-11-22',
  price,updated_at:stale(minutes),transfers:flight_type==='direct'?0:1,airline:'NX'};}

function revision(dest,flight_type,minutes,price,overrides={}){return {origin:'FRA',dest,destination_id:dest.toLowerCase(),flight_type,
  departure_at:'2026-11-20',return_at:'2026-11-22',exact_price:price,exact_observed_at:stale(minutes),
  transfers:flight_type==='direct'?0:1,airline:'NX',price_source:{table:'window_prices'},...overrides};}

test('direct error uses only the matching fresh alternate from the latest revision candidates',async()=>{
  const result=await selected({flightType:'direct',response:{kind:'refused',refusal:'timeout'},offers:[offer('CTA','direct',31,56)],revisionCandidates:[
    revision('LIS','direct',5,1,{origin:'MUC'}),revision('CTA','any',5,2),revision('BCN','direct',5,3,{departure_at:'2026-11-21'}),revision('CPH','direct',5,75),
  ]});
  assert.equal(result.status,'error');assert.equal(result.outcome,'replaced');
  assert.equal(result.replacement.dest,'CPH');assert.equal(result.replacement.price,75);
});

test('any confirmed absence uses only the matching fresh alternate from the latest revision candidates',async()=>{
  const result=await selected({flightType:'any',response:{kind:'ok',json:{success:true,data:[]}},offers:[offer('CTA','any',31,56)],revisionCandidates:[
    revision('LIS','any',5,1,{origin:'MUC'}),revision('CTA','direct',5,2),revision('BCN','any',5,3,{return_at:'2026-11-23'}),revision('CPH','any',5,75),
  ]});
  assert.equal(result.status,'confirmed_absent');assert.equal(result.outcome,'replaced');
  assert.equal(result.replacement.dest,'CPH');assert.equal(result.replacement.price,75);
});

for(const flightType of ['direct','any']){
  test(`${flightType}: stale current selects only a separately fresh exact-date alternate`,async()=>{
    const result=await selected({flightType,response:{kind:'refused',refusal:'timeout'},offers:[offer('FCO',flightType,31,65),offer('CPH',flightType,5,75)]});
    assert.equal(result.status,'error');assert.equal(result.outcome,'replaced');
    assert.deepEqual(result.replacement,{...offer('CPH',flightType,5,75),destination_id:'copenhagen'});
  });

  test(`${flightType}: unchanged exact confirmation retains the current city`,async()=>{
    const result=await selected({flightType,offers:[],response:{kind:'ok',json:{success:true,data:[{origin:'FRA',destination:'FCO',
      departure_at:'2026-11-20T08:00:00Z',return_at:'2026-11-22T20:00:00Z',price:65,transfers:flightType==='direct'?0:1,airline:'NX'}]}}});
    assert.equal(result.status,'found');assert.equal(result.fare.price,65);assert.equal(result.replacement,undefined);
  });

  test(`${flightType}: no fresh exact-date alternate retains the documented fallback`,async()=>{
    const result=await selected({flightType,response:{kind:'refused',refusal:'timeout'},offers:[offer('CTA',flightType,31,56)]});
    assert.deepEqual(result,{status:'error',outcome:'retain_no_alternate',replacement:null});
  });

  test(`${flightType}: unavailable or unconfirmed outcomes never publish a fresh quote without an alternate`,async()=>{
    for(const response of [{kind:'ok',json:{success:true,data:[]}},{kind:'refused',refusal:'timeout'}]){
      const result=await selected({flightType,response,offers:[offer('FCO',flightType,5,65),offer('CTA',flightType,31,56)]});
      assert.ok(['confirmed_absent','error'].includes(result.status));
      assert.equal(result.outcome,'retain_no_alternate');assert.equal(result.replacement,null);assert.equal(result.fare,undefined);
    }
  });
}
