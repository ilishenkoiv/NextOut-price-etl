import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from './collection-adapters.mjs';

const now=Date.parse('2026-11-12T12:00:00Z');
const snapshot='2026-11-12T07:00:00Z';
const stamp=minutes=>new Date(now-minutes*60_000).toISOString();

function table(rows,filters=[]){return new Proxy({}, {get:(_,key)=>{
  if(key==='then'){const data=rows.filter(row=>filters.every(([field,value])=>row?.[field]===value));const result=Promise.resolve({data,error:null});return result.then.bind(result);}
  if(key==='eq')return(field,value)=>table(rows,[...filters,[field,value]]);
  return()=>table(rows,filters);
}});}

function ticket(flight_type){return {observed_on:'2026-11-12',origin:'FRA',snapshot_at:snapshot,destination_id:'rome',dest:'FCO',flight_type,
  departure_at:'2026-11-20',return_at:'2026-11-22',position:1,window_kind:'weekend',exact_price:65,transfers:flight_type==='direct'?0:1,
  airline:null,exact_observed_at:stamp(31),refresh_status:'fresh',price_source:{}};}

function revision(dest,flight_type,minutes,price,overrides={}){return {observed_on:'2026-11-12',origin:'FRA',snapshot_at:'2026-11-12T11:30:00Z',
  destination_id:dest.toLowerCase(),dest,flight_type,departure_at:'2026-11-20',return_at:'2026-11-22',exact_price:price,
  transfers:flight_type==='direct'?0:1,airline:'NX',exact_observed_at:stamp(minutes),refresh_status:'fresh',price_source:{},...overrides};}

async function refresh({flight_type,response,offers=[],revisions=[]}){
  const base=ticket(flight_type);const calls=[];
  const rows={selected_price_refresh_control:[{singleton:true,enabled:true,generation:1,main12h_rollback:false}],
    daily_origin_window_candidate_runs:[{observed_on:'2026-11-12',origin:'FRA',snapshot_at:snapshot,contract_version:1,candidate_rows:1,exact_request_groups:1}],
    daily_origin_window_candidates:[base],offers,
    daily_origin_window_candidate_revisions:revisions.length?[{observed_on:'2026-11-12',origin:'FRA',revision:1,snapshot_at:'2026-11-12T11:30:00Z'}]:[],
    daily_origin_window_candidate_revision_candidates:revisions};
  const db={from:name=>table(rows[name]??[]),rpc:async(name,args)=>{calls.push({name,args});return{data:true,error:null};},storage:{from:()=>({})}};
  const store={args:()=>({p_owner:'test',p_token:1}),lease:async()=>true,runId:'test',plan:async(_key,build)=>build()};
  const provider={request:async()=>response};
  const result=await createAdapters({db,store,provider,clock:()=>now,wave:0}).priority.step({job:{id:1,planDate:'2026-11-12',startedAt:now,
    checkpoint:{cycle:1,phase:'weekend',dueAt:now,roulette:{done:true}}},deadline:now+200000});
  const commit=calls.find(call=>call.name==='collection_commit_selected_carousel');
  assert.equal(result.checkpoint.weekend.errors,response.kind==='refused'?1:0);assert.ok(commit);
  return commit.args.p_result;
}

test('direct error selects the only fresh matching alternate from the latest revision',async()=>{
  const result=await refresh({flight_type:'direct',response:{kind:'refused',refusal:'timeout'},offers:[{origin:'FRA',dest:'CTA',flight_type:'direct',departure_at:'2026-11-20',return_at:'2026-11-22',price:56,transfers:0,updated_at:stamp(31)}],revisions:[
    revision('LIS','direct',5,1,{origin:'MUC'}),revision('CTA','any',5,2),revision('BCN','direct',5,3,{departure_at:'2026-11-21'}),revision('CPH','direct',5,75),
  ]});
  assert.equal(result.outcome,'replaced');assert.equal(result.replacement.dest,'CPH');assert.equal(result.replacement.price,75);
});

test('any confirmed absence selects the only fresh matching alternate from the latest revision',async()=>{
  const result=await refresh({flight_type:'any',response:{kind:'ok',json:{success:true,data:[]}},offers:[{origin:'FRA',dest:'CTA',flight_type:'any',departure_at:'2026-11-20',return_at:'2026-11-22',price:56,transfers:1,updated_at:stamp(31)}],revisions:[
    revision('LIS','any',5,1,{origin:'MUC'}),revision('CTA','direct',5,2),revision('BCN','any',5,3,{return_at:'2026-11-23'}),revision('CPH','any',5,75),
  ]});
  assert.equal(result.outcome,'replaced');assert.equal(result.replacement.dest,'CPH');assert.equal(result.replacement.price,75);
});

for(const flight_type of ['direct','any']){
  test(`${flight_type}: fresh offer replaces while stale alternates retain the published fallback`,async()=>{
    const fresh={origin:'FRA',dest:'CPH',flight_type,departure_at:'2026-11-20',return_at:'2026-11-22',price:75,transfers:flight_type==='direct'?0:1,updated_at:stamp(5)};
    const replaced=await refresh({flight_type,response:{kind:'refused',refusal:'timeout'},offers:[fresh]});
    assert.equal(replaced.outcome,'replaced');assert.equal(replaced.replacement.dest,'CPH');
    const retained=await refresh({flight_type,response:{kind:'refused',refusal:'timeout'},offers:[{...fresh,updated_at:stamp(31)}],revisions:[{...revision('CTA',flight_type,31,56)}]});
    assert.equal(retained.outcome,'retained');assert.equal(retained.replacement,undefined);
  });

  test(`${flight_type}: unchanged numeric exact confirmation remains fresh`,async()=>{
    const result=await refresh({flight_type,response:{kind:'ok',json:{success:true,data:[{origin:'FRA',destination:'FCO',departure_at:'2026-11-20T08:00:00Z',return_at:'2026-11-22T20:00:00Z',price:65,transfers:flight_type==='direct'?0:1}]}}});
    assert.equal(result.status,'found');assert.equal(result.fare.price,65);
  });
}
