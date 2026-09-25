import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters, MAIN_REQUIRED_PROVIDER_CALLS, projectMainCellMs } from './collection-adapters.mjs';
import { CollectionYield } from './collection-provider.mjs';

function fixture(plan,response,{tableRows={},clock=()=>100000}={}){
  const calls=[];
  const chain=data=>new Proxy({}, {get:(_,key)=>key==='then'?Promise.resolve({data,error:null}).then.bind(Promise.resolve({data,error:null})):()=>chain(data)});
  const db={rpc:(name,args)=>{calls.push({name,args});return Promise.resolve({data:true,error:null});},
    from:table=>chain(tableRows[table]??[]),storage:{from:()=>({upload:async()=>({data:{},error:null})})}};
  const store={args:()=>({p_owner:'test-owner',p_token:1}),lease:async()=>true,plan:async()=>plan,runId:'123'};
  let requests=0;
  const provider={request:async url=>{requests++;return response(requests,url);}};
  return{adapters:createAdapters({db,store,provider,clock,wave:10}),calls,get requests(){return requests;}};
}
function withPilotMarketSchedule(fn){
  const previous=process.env.PRIORITY_MARKET_SCHEDULE;process.env.PRIORITY_MARKET_SCHEDULE='pilot';
  return Promise.resolve().then(fn).finally(()=>{if(previous===undefined)delete process.env.PRIORITY_MARKET_SCHEDULE;else process.env.PRIORITY_MARKET_SCHEDULE=previous;});
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
test('malformed roulette data preserves the existing offer and defers the ticket to the next pass',async()=>{
  const ticket={origin:'FRA',dest:'MAD',flight_type:'direct',departure_at:'2027-01-10',return_at:'2027-01-17'};
  const f=fixture({tickets:[ticket]},()=>({kind:'ok',json:{success:true,data:{}}}));
  const checkpoint={cycle:job.id,phase:'roulette',dueAt:0,roulette:{cycle:job.id,cursor:0,errors:0,done:false}};
  const result=await f.adapters.priority.step({job:{...job,checkpoint},deadline:200000});
  assert.equal(f.calls.length,0,'technical/malformed results never mutate offers or pool');
  assert.equal(result.checkpoint.roulette.errors,1);
  assert.equal(result.checkpoint.roulette.cursor,1);
  assert.equal(result.checkpoint.roulette.technicalDeferred[0].stage,'ticket');
});

test('pilot market schedule (off by default): a night-hours instant skips priority entirely for that origin, zero provider calls, cursor still resolves done',async()=>{
  await withPilotMarketSchedule(async()=>{
    const ticket={origin:'FRA',dest:'MAD',flight_type:'direct',departure_at:'2027-01-10',return_at:'2027-01-17'};
    const nightUtc=Date.parse('2026-01-15T01:00:00Z'); // 02:00 Europe/Berlin — night, mainOnly
    const f=fixture({tickets:[ticket],allowedDests:[],replacements:{}},()=>({kind:'ok',json:{success:true,data:[offer]}}),{clock:()=>nightUtc});
    const checkpoint={cycle:job.id,phase:'roulette',dueAt:0,roulette:{cycle:job.id,cursor:0,errors:0,done:false}};
    const result=await f.adapters.priority.step({job:{...job,checkpoint},deadline:nightUtc+200000});
    assert.equal(f.requests,0,'no provider call for an origin whose market-local time is inside the night gap');
    assert.equal(result.checkpoint.roulette.total,0);
    assert.equal(result.checkpoint.roulette.done,true);
  });
});

test('pilot market schedule (off by default): a DACH peak-hours instant still refreshes that origin normally',async()=>{
  await withPilotMarketSchedule(async()=>{
    const ticket={origin:'FRA',dest:'MAD',flight_type:'direct',departure_at:'2027-01-10',return_at:'2027-01-17'};
    const peakUtc=Date.parse('2026-01-15T19:00:00Z'); // 20:00 Europe/Berlin — DACH peak (19:00-23:00)
    const f=fixture({tickets:[ticket],allowedDests:[],replacements:{}},()=>({kind:'ok',json:{success:true,data:[offer]}}),{clock:()=>peakUtc});
    const checkpoint={cycle:job.id,phase:'roulette',dueAt:0,roulette:{cycle:job.id,cursor:0,errors:0,done:false}};
    const result=await f.adapters.priority.step({job:{...job,checkpoint},deadline:peakUtc+200000});
    assert.equal(f.requests,1,'the one selected ticket is still refreshed at peak local time');
    assert.equal(result.checkpoint.roulette.total,1);
  });
});

test('pilot market schedule (window/carousel path): a night-hours instant skips that origin\'s window group entirely — parity with the roulette path above',async()=>{
  await withPilotMarketSchedule(async()=>{
    const nightUtc=Date.parse('2026-01-15T01:00:00Z'); // 02:00 Europe/Berlin — night, mainOnly
    const ticket={origin:'FRA',dest:'MAD',flight_type:'direct',departure_at:'2027-01-10',return_at:'2027-01-17',
      position:1,window_kind:'weekend',exact_observed_at:'2026-01-14T09:00:00Z',updated_at:'2026-01-14T09:00:00Z'};
    const plan={day:'2026-01-15',setId:'daily-window:test',selectedAt:'2026-01-15T00:00:00Z',tickets:[ticket],groups:[[ticket]]};
    const f=fixture(plan,()=>({kind:'ok',json:{success:true,data:[offer]}}),{clock:()=>nightUtc,
      tableRows:{daily_window_candidate_epochs:[{observed_on:'2026-01-15',snapshot_at:'2026-01-15T00:00:00Z',contract_version:1,candidate_rows:1,exact_request_groups:1}]}});
    const checkpoint={cycle:job.id,phase:'weekend',dueAt:0,roulette:{done:true}};
    const result=await f.adapters.priority.step({job:{...job,checkpoint},deadline:nightUtc+200000});
    assert.equal(f.requests,0,'no provider call for a window group whose origin is inside the night gap');
    assert.equal(result.checkpoint.weekend.total,0);
    assert.equal(result.checkpoint.weekend.done,true);
  });
});

test('pilot market schedule (window/carousel path): a DACH peak-hours instant still refreshes that origin\'s group normally',async()=>{
  await withPilotMarketSchedule(async()=>{
    const peakUtc=Date.parse('2026-01-15T19:00:00Z'); // 20:00 Europe/Berlin — DACH peak (19:00-23:00)
    const ticket={origin:'FRA',dest:'MAD',flight_type:'direct',departure_at:'2027-01-10',return_at:'2027-01-17',
      position:1,window_kind:'weekend',exact_observed_at:'2026-01-14T09:00:00Z',updated_at:'2026-01-14T09:00:00Z'};
    const plan={day:'2026-01-15',setId:'daily-window:test',selectedAt:'2026-01-15T00:00:00Z',tickets:[ticket],groups:[[ticket]]};
    const f=fixture(plan,()=>({kind:'ok',json:{success:true,data:[offer]}}),{clock:()=>peakUtc,
      tableRows:{daily_window_candidate_epochs:[{observed_on:'2026-01-15',snapshot_at:'2026-01-15T00:00:00Z',contract_version:1,candidate_rows:1,exact_request_groups:1}]}});
    const checkpoint={cycle:job.id,phase:'weekend',dueAt:0,roulette:{done:true}};
    const result=await f.adapters.priority.step({job:{...job,checkpoint},deadline:peakUtc+200000});
    assert.equal(f.requests,1,'the one selected window group is still refreshed at peak local time');
    assert.equal(result.checkpoint.weekend.total,1);
  });
});

test('pilot market schedule leaves the LEGACY (default, unset) path byte-identical: same origin/instant processes normally', async()=>{
  const ticket={origin:'FRA',dest:'MAD',flight_type:'direct',departure_at:'2027-01-10',return_at:'2027-01-17'};
  const nightUtc=Date.parse('2026-01-15T01:00:00Z');
  assert.equal(process.env.PRIORITY_MARKET_SCHEDULE,undefined,'must not leak from a previous test');
  const f=fixture({tickets:[ticket],allowedDests:[],replacements:{}},()=>({kind:'ok',json:{success:true,data:[offer]}}),{clock:()=>nightUtc});
  const checkpoint={cycle:job.id,phase:'roulette',dueAt:0,roulette:{cycle:job.id,cursor:0,errors:0,done:false}};
  const result=await f.adapters.priority.step({job:{...job,checkpoint},deadline:nightUtc+200000});
  assert.equal(f.requests,1,'without the pilot flag, night hours change nothing — exactly legacy behavior');
  assert.equal(result.checkpoint.roulette.total,1);
});

// Regression coverage for the latest-row-only daily_window_candidate_epochs read
// (collection-adapters.mjs, weekend phase): the epoch query changed from an ascending
// full-table page scan (`load(...).at(-1)`) to `order(desc).limit(1)`, which reads exactly
// the one row snapshot_at's UNIQUE constraint guarantees is the latest. These tests pin the
// invalidation/resume semantics the weekend phase depends on, so a future change to that
// query cannot silently reintroduce stale or duplicated progress.
const windowTicketA={origin:'FRA',dest:'MAD',flight_type:'direct',departure_at:'2027-01-10',return_at:'2027-01-17',
  position:1,window_kind:'weekend',exact_observed_at:'2026-01-14T09:00:00Z',updated_at:'2026-01-14T09:00:00Z'};
const windowTicketB={origin:'FRA',dest:'ROM',flight_type:'direct',departure_at:'2027-01-10',return_at:'2027-01-17',
  position:2,window_kind:'weekend',exact_observed_at:'2026-01-14T09:00:00Z',updated_at:'2026-01-14T09:00:00Z'};
const twoGroupPlan={day:'2026-01-15',setId:'daily-window:test',selectedAt:'2026-01-15T00:00:00Z',
  tickets:[windowTicketA,windowTicketB],groups:[[windowTicketA],[windowTicketB]]};
const someUtc=Date.parse('2026-01-15T12:00:00Z');

test('weekend phase: an unchanged latest epoch (retry/resume) continues the cursor instead of restarting the pass',async()=>{
  const epoch={observed_on:'2026-01-15',snapshot_at:'2026-01-15T00:00:00Z',contract_version:1,candidate_rows:2,exact_request_groups:2};
  const f=fixture(twoGroupPlan,()=>({kind:'ok',json:{success:true,data:[offer]}}),{clock:()=>someUtc,
    tableRows:{daily_window_candidate_epochs:[epoch]}});
  const checkpoint={cycle:job.id,phase:'weekend',dueAt:0,roulette:{done:true},
    weekend:{day:'2026-01-15',dayId:1,cursor:1,done:false,errors:0,passStartedAt:0,snapshotAt:epoch.snapshot_at}};
  const result=await f.adapters.priority.step({job:{...job,checkpoint},deadline:someUtc+200000});
  assert.equal(f.requests,1,'only the still-pending second group is refreshed, not a restarted first group');
  assert.equal(result.checkpoint.weekend.snapshotAt,epoch.snapshot_at);
  assert.equal(result.checkpoint.weekend.cursor,2,'resumes from cursor=1 to cursor=2, never resets to 0');
  assert.equal(result.checkpoint.weekend.done,true);
});

test('weekend phase: a new epoch publication (or Berlin-day rollover, which always emits one) invalidates in-flight progress',async()=>{
  const newEpoch={observed_on:'2026-01-16',snapshot_at:'2026-01-16T00:00:00Z',contract_version:1,candidate_rows:2,exact_request_groups:2};
  const f=fixture(twoGroupPlan,()=>({kind:'ok',json:{success:true,data:[offer]}}),{clock:()=>someUtc,
    tableRows:{daily_window_candidate_epochs:[newEpoch]}});
  const staleCheckpoint={cycle:job.id,phase:'weekend',dueAt:0,roulette:{done:true},
    weekend:{day:'2026-01-15',dayId:1,cursor:1,done:false,errors:3,passStartedAt:0,snapshotAt:'2026-01-15T00:00:00Z'}};
  const result=await f.adapters.priority.step({job:{...job,checkpoint:staleCheckpoint},deadline:someUtc+200000});
  assert.equal(result.checkpoint.weekend.snapshotAt,newEpoch.snapshot_at,'adopts the new latest epoch');
  assert.equal(result.checkpoint.weekend.cursor,1,'restarts at group 0 and advances to 1, discarding the stale cursor=1 from the old epoch');
  assert.equal(result.checkpoint.weekend.errors,0,'stale error count from the superseded epoch is not carried forward');
});

test('weekend phase: no epoch rows at all is reported as blocked, not an empty-latest-row crash',async()=>{
  const f=fixture(twoGroupPlan,()=>({kind:'ok',json:{success:true,data:[offer]}}),{clock:()=>someUtc,
    tableRows:{daily_window_candidate_epochs:[]}});
  const checkpoint={cycle:job.id,phase:'weekend',dueAt:0,roulette:{done:true}};
  const result=await f.adapters.priority.step({job:{...job,checkpoint},deadline:someUtc+200000});
  assert.equal(f.requests,0);
  assert.equal(result.status,'done');
  assert.equal(result.checkpoint.weekend.blockedReason,'no_daily_window_candidate_epoch');
  assert.equal(result.checkpoint.weekend.done,true);
});
