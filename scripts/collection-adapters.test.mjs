import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters, MAIN_REQUIRED_PROVIDER_CALLS, projectMainCellMs } from './collection-adapters.mjs';
import { CollectionYield } from './collection-provider.mjs';

function fixture(plan,response,{tableRows={}}={}){
  const calls=[];
  const chain=data=>new Proxy({}, {get:(_,key)=>key==='then'?Promise.resolve({data,error:null}).then.bind(Promise.resolve({data,error:null})):()=>chain(data)});
  const db={rpc:(name,args)=>{calls.push({name,args});return Promise.resolve({data:true,error:null});},
    from:table=>chain(tableRows[table]??[]),storage:{from:()=>({upload:async()=>({data:{},error:null})})}};
  const store={args:()=>({p_owner:'test-owner',p_token:1}),lease:async()=>true,plan:async()=>plan,runId:'123'};
  let requests=0;
  const provider={request:async url=>{requests++;return response(requests,url);}};
  return{adapters:createAdapters({db,store,provider,clock:()=>100000,wave:10}),calls,get requests(){return requests;}};
}
const job={id:1,planDate:'2026-09-16',startedAt:100000,checkpoint:null};
const mainPlan={months:['2027-01'],routes:[{origin:'FRA',dest:'MAD',stops:0,key:'FRA|MAD'}],breakKeys:[]};
const offer={departure_at:'2027-01-10T08:00:00Z',return_at:'2027-01-17T09:00:00Z',price:123,transfers:0};

test('MAIN capacity counts four mandatory calls plus explicit fallback/retry overhead',()=>{
  assert.equal(MAIN_REQUIRED_PROVIDER_CALLS,4);assert.equal(projectMainCellMs({requestMs:500,dbMs:100}),2100);
  assert.equal(projectMainCellMs({requestMs:500,dbMs:100,calendarFallback:true,retryCalls:2}),3600);
  assert.equal(projectMainCellMs({requestMs:8000,dbMs:100}),32100);
});

const okFare=(price,transfers)=>({kind:'ok',json:{success:true,data:[{...offer,price,transfers}]}});

test('MAIN unconditionally collects direct=200 and any=100 and commits both independent variants',async()=>{
  const f=fixture(mainPlan,(_n,url)=>okFare(url.includes('direct=true')?200:100,url.includes('direct=true')?0:1));
  const result=await f.adapters.main.step({job,deadline:200000});
  assert.equal(f.requests,4);
  assert.equal(f.calls.length,2);assert.equal(f.calls[0].name,'collection_commit_main');
  assert.equal(f.calls[1].name,'collection_record_route_observation');
  assert.equal(f.calls[0].args.p_price.direct,200);
  assert.equal(f.calls[0].args.p_price.any_stops,100);
  assert.equal(f.calls[0].args.p_price.direct_observed,true);
  assert.equal(f.calls[0].args.p_price.any_observed,true);
  assert.equal(f.calls[0].args.p_price.market,'de');
  assert.equal(f.calls[0].args.p_price.price_source.variants.direct.round_trip_validated,true);
  assert.equal(f.calls[0].args.p_price.price_source.variants.any.round_trip_validated,true);
  assert.ok(f.calls[0].args.p_offers.length>=1);
  assert.equal(result.checkpoint.cursor,1);
  // Stage 3: reaching total completes the pass directly. Main no longer runs a selection
  // (pool rebuild) stage — that is the nightly selection owner's job.
  assert.equal(result.status,'done');
  assert.equal(result.checkpoint.stage,'complete');
});
test('MAIN preserves actual direct=100 and any=200 without replacing any by the cheaper side',async()=>{
  const f=fixture(mainPlan,(_n,url)=>okFare(url.includes('direct=true')?100:200,url.includes('direct=true')?0:1));
  await f.adapters.main.step({job,deadline:200000});
  assert.equal(f.requests,4);
  assert.equal(f.calls[0].args.p_price.direct,100);
  assert.equal(f.calls[0].args.p_price.any_stops,200);
});
test('first upstream request error does not skip the other window or either required variant',async()=>{
  const f=fixture(mainPlan,(n,url)=>n===1?{kind:'refused',refusal:'server'}:okFare(url.includes('direct=true')?180:120,url.includes('direct=true')?0:1));
  const result=await f.adapters.main.step({job,deadline:200000});
  assert.equal(f.requests,4);assert.equal(result.checkpoint.errors,0);
  assert.equal(f.calls[0].args.p_price.direct,180);assert.equal(f.calls[0].args.p_price.any_stops,120);
});
test('both required probe failures record gaps without price/no-price writes',async()=>{
  const f=fixture(mainPlan,()=>({kind:'refused',refusal:'server'}));
  const result=await f.adapters.main.step({job,deadline:200000});
  assert.equal(f.requests,4);assert.equal(f.calls.length,0);assert.equal(result.checkpoint.errors,2);
});
test('one confirmed-empty side plus one failed side is not no-price evidence and cannot erase history',async()=>{
  const f=fixture(mainPlan,(_n,url)=>url.includes('direct=true')?{kind:'ok',json:{success:true,data:[]}}:{kind:'refused',refusal:'server'});
  const result=await f.adapters.main.step({job,deadline:200000});
  assert.equal(f.requests,4,'calendar fallback is not attempted after a required failure');
  assert.equal(f.calls.length,0);assert.equal(result.checkpoint.errors,1);
});
test('two confirmed-empty variants are required before the month becomes no-price evidence',async()=>{
  const f=fixture(mainPlan,()=>({kind:'ok',json:{success:true,data:[]}}));
  await f.adapters.main.step({job,deadline:200000});
  assert.equal(f.requests,5,'positive-only calendar fallback is explicit overhead');
  assert.deepEqual(f.calls.map(c=>c.name),['collection_record_route_observation']);
  assert.equal(f.calls[0].args.p_has_price,false);
});
test('positive calendar fallback may add a fare after two required empties but never hides a failed required probe',async()=>{
  const f=fixture(mainPlan,(n)=>n<5?{kind:'ok',json:{success:true,data:[]}}:{kind:'ok',json:{success:true,data:[{
    value:140,depart_date:'2027-01-10',return_date:'2027-01-17',number_of_changes:1}]}});
  await f.adapters.main.step({job,deadline:200000});
  assert.equal(f.requests,5);assert.equal(f.calls[0].args.p_price.any_stops,140);
  assert.equal(f.calls[0].args.p_price.price_source.variants.any.source,'calendar');
});
test('restart between required probes leaves cursor unchanged and replays both variants before one commit',async()=>{
  const f=fixture(mainPlan,(n,url)=>{if(n===3)throw new CollectionYield('boundary');return okFare(url.includes('direct=true')?170:130,url.includes('direct=true')?0:1);});
  const first=await f.adapters.main.step({job,deadline:200000});
  assert.equal(first.status,'yield');assert.equal(first.checkpoint.cursor,0);assert.equal(f.calls.length,0);
  const second=await f.adapters.main.step({job:{...job,checkpoint:first.checkpoint},deadline:200000});
  assert.equal(second.checkpoint.cursor,1);assert.equal(f.calls.filter(c=>c.name==='collection_commit_main').length,1);
  assert.equal(f.calls.find(c=>c.name==='collection_commit_main').args.p_price.direct,170);
  assert.equal(f.calls.find(c=>c.name==='collection_commit_main').args.p_price.any_stops,130);
});
test('a malformed fast response writes a diagnostic miss, never an empty fare',async()=>{
  const ticket={origin:'FRA',dest:'MAD',flight_type:'direct',departure_at:'2027-01-10',return_at:'2027-01-17',nights:7,window_kind:'weekend'};
  const f=fixture({tickets:[ticket]},()=>({kind:'ok',json:{success:true,data:{}}}));
  const result=await f.adapters.fast.step({job,deadline:200000});
  assert.equal(f.calls[0].name,'collection_commit_window');
  assert.equal(f.calls[0].args.p_fare,null);
  assert.equal(f.calls[0].args.p_miss.outcome,'http_error');
  assert.equal(result.checkpoint.errors,1);
});
test('FAST preserves its duties but skips an exact key already refreshed by priority inside 30 minutes',async()=>{
  const ticket={origin:'FRA',dest:'MAD',flight_type:'direct',departure_at:'2027-01-10',return_at:'2027-01-17',nights:7,window_kind:'weekend'};
  const f=fixture({tickets:[ticket]},()=>{throw new Error('duplicate provider request');},{tableRows:{window_prices:[{updated_at:new Date(100000).toISOString()}]}});
  const result=await f.adapters.fast.step({job,deadline:200000});
  assert.equal(f.requests,0);assert.equal(result.checkpoint.reusedPriority,1);assert.equal(result.status,'done');
});
test('a saved wave is retained when the next runner has a different rollout setting',async()=>{
  const f=fixture(mainPlan,()=>({kind:'ok',json:{success:true,data:[offer]}}));
  const result=await f.adapters.main.step({job:{...job,checkpoint:{cursor:0,errors:0,wave:0}},deadline:200000});
  assert.equal(result.checkpoint.wave,0);
});
test('malformed roulette data preserves the existing offer and advances diagnostic progress',async()=>{
  const ticket={origin:'FRA',dest:'MAD',flight_type:'direct',departure_at:'2027-01-10',return_at:'2027-01-17'};
  const f=fixture({tickets:[ticket]},()=>({kind:'ok',json:{success:true,data:{}}}));
  const checkpoint={cycle:job.id,phase:'roulette',dueAt:0,roulette:{cycle:job.id,cursor:0,errors:0,done:false}};
  const result=await f.adapters.priority.step({job:{...job,checkpoint},deadline:200000});
  assert.equal(f.calls[0].name,'collection_commit_roulette');
  assert.equal(f.calls[0].args.p_result.status,'error');
  assert.equal(result.checkpoint.roulette.errors,1);
});
