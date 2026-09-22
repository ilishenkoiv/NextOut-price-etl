import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters, selectWindowConsumerSet, windowConsumerSetId, groupWindowConsumerTickets, buildRouletteReplacementCandidates } from './collection-adapters.mjs';

function chain(data){return new Proxy({}, {get:(_,key)=>key==='then'
  ? Promise.resolve({data,error:null}).then.bind(Promise.resolve({data,error:null}))
  : ()=>chain(data)});}

test('weekend refresh snapshots one stable daily consumer set and resumes its full cursor without reselection',async()=>{
  const now=Date.parse('2026-09-22T10:00:00Z');
  let source=Array.from({length:96},(_,i)=>({origin:'BER',dest:`D${String(i).padStart(3,'0')}`,flight_type:'any',
    destination_id:`fixture-${i}`,position:i+1,snapshot_at:'2026-09-22T03:30:00Z',departure_at:'2026-10-10',return_at:'2026-10-17',
    window_kind:i%2?'weekend':'holiday',exact_observed_at:'2026-09-22T09:00:00Z',refresh_status:'fresh'}));
  const commits=[];const planKeys=[];const cache=new Map();
  const db={from:table=>chain(table==='daily_window_candidate_epochs'?[{observed_on:'2026-09-22',snapshot_at:'2026-09-22T03:30:00Z',contract_version:1,
      candidate_rows:96,exact_request_groups:96}]:table==='daily_window_candidates'?source:[]),
    rpc:(name,args)=>{commits.push({name,args});return Promise.resolve({data:true,error:null});},
    storage:{from:()=>({})}};
  const store={args:()=>({p_owner:'o',p_token:1}),lease:async()=>true,runId:'r',plan:async(key,build)=>{
    planKeys.push(key);if(!cache.has(key))cache.set(key,await build());return cache.get(key);
  }};
  const requested=[];const provider={request:async url=>{requested.push(url);const u=new URL(url);return{kind:'ok',json:{success:true,data:[{
    origin:u.searchParams.get('origin'),destination:u.searchParams.get('destination'),departure_at:'2026-10-10T06:00:00Z',
    return_at:'2026-10-17T20:00:00Z',price:111,transfers:1}]}};}};
  const adapters=createAdapters({db,store,provider,clock:()=>now,wave:0});
  const job={id:1,planDate:'2026-09-22',startedAt:now,checkpoint:{cycle:1,dueAt:now,phase:'weekend',auditDone:true,
    roulette:{cycle:1,cursor:0,done:true,errors:0}}};
  const r1=await adapters.priority.step({job,deadline:now+200000});
  const r2=await adapters.priority.step({job:{...job,checkpoint:r1.checkpoint},deadline:now+200000});
  assert.equal(r2.status,'progress');assert.equal(r2.checkpoint.weekend.cursor,2);assert.equal(r2.checkpoint.weekend.total,96);
  assert.equal(requested.length,2);assert.equal(commits.filter(c=>c.name==='collection_commit_window_candidate').length,2);
  assert.equal(new Set(planKeys).size,1,'one durable daily plan key; refresh does not re-select');

  source=[{...source[0],dest:'CHANGED'}];
  const next={...r2.checkpoint,cycle:2,phase:'weekend'};
  const r3=await adapters.priority.step({job:{...job,id:2,checkpoint:next},deadline:now+200000});
  assert.equal(r3.checkpoint.weekend.cursor,3);
  assert.match(requested[2],/destination=D002/,'resume uses the saved set/order, not changed live membership');
  assert.equal(r3.checkpoint.weekend.setId,r2.checkpoint.weekend.setId,'daily set identity remains frozen');
});

test('cache-inventory helper has no invented top-N or /48 shortcut and preserves >1000 exact rows',()=>{
  const rows=Array.from({length:1205},(_,i)=>({origin:'BER',dest:`D${i}`,flight_type:i%2?'direct':'any',
    departure_at:'2026-10-10',return_at:'2026-10-17',window_kind:'weekend'}));
  const selected=selectWindowConsumerSet(rows,'2026-09-22');
  assert.equal(selected.length,1205);assert.match(windowConsumerSetId(selected,'2026-09-22'),/^window-consumer:2026-09-22:[a-f0-9]{20}$/);
  assert.equal(selectWindowConsumerSet([{...rows[0],departure_at:'2026-09-25'},{...rows[1],departure_at:'2027-02-01'},
    {...rows[2],window_kind:'weekend_around'}],'2026-09-22').length,0,'matches app lead/horizon/kind eligibility');
});

test('direct+any rows for one exact route/date use one provider request group without changing row membership',()=>{
  const rows=[{origin:'BER',dest:'BCN',flight_type:'direct',departure_at:'2026-10-10',return_at:'2026-10-17',window_kind:'weekend'},
    {origin:'BER',dest:'BCN',flight_type:'any',departure_at:'2026-10-10',return_at:'2026-10-17',window_kind:'weekend'}];
  const groups=groupWindowConsumerTickets(rows);assert.equal(groups.length,1);assert.deepEqual(groups[0].map(r=>r.flight_type),['any','direct']);
  assert.equal(groups[0].length,rows.length);
});

test('roulette replacement seeds preserve mode and exclude every city already in the pool',()=>{
  const pool=[{origin:'BER',dest:'BCN',flight_type:'any'}];
  const common={origin:'BER',market:'de',departure_at:'2026-10-10',return_at:'2026-10-17',price:100,updated_at:'2026-09-22T10:00:00Z'};
  const offers=[{...common,dest:'ATH',flight_type:'direct',transfers:0},{...common,dest:'ATH',flight_type:'any',transfers:1,price:110},
    {...common,dest:'BCN',flight_type:'any',transfers:1,price:90}];
  const result=buildRouletteReplacementCandidates(offers,pool,['BCN','ATH'],'2026-09-22');
  assert.deepEqual(result['BER|direct'].map(row=>row.dest),['ATH']);
  assert.deepEqual(result['BER|any'].map(row=>row.dest),['ATH']);
  assert.equal(Object.values(result).flat().some(row=>row.dest==='BCN'),false);
});

test('missing daily epoch fails closed without treating cache rows as selected',async()=>{
  const now=Date.parse('2026-09-23T10:00:00Z');let requests=0;
  const db={from:()=>chain([]),rpc:()=>Promise.resolve({data:true,error:null}),storage:{from:()=>({})}};
  const store={args:()=>({p_owner:'o',p_token:1}),lease:async()=>true,runId:'r',plan:async()=>{throw new Error('must not build a plan without epoch');}};
  const adapters=createAdapters({db,store,provider:{request:async()=>{requests++;}},clock:()=>now});
  const result=await adapters.priority.step({job:{id:2,planDate:'2026-09-23',checkpoint:{cycle:2,dueAt:now,phase:'weekend',roulette:{done:true}}},deadline:now+200000});
  assert.equal(result.status,'done');assert.equal(result.checkpoint.weekend.blockedReason,'no_daily_window_candidate_epoch');assert.equal(requests,0);
});

test('priority writes are fenced: lease loss prevents weekend fare commit',async()=>{
  const now=Date.parse('2026-09-22T10:00:00Z');
  const db={from:()=>chain([{observed_on:'2026-09-22',snapshot_at:'2026-09-22T03:30:00Z',contract_version:1,candidate_rows:1,exact_request_groups:1}]),
    rpc:()=>Promise.resolve({data:true,error:null}),storage:{from:()=>({})}};
  const store={args:()=>({p_owner:'o',p_token:1}),lease:async()=>false,runId:'r',plan:async(_key,build)=>build()};
  const adapters=createAdapters({db,store,provider:{request:async()=>{throw new Error('must not request');}},clock:()=>now});
  await assert.rejects(()=>adapters.priority.step({job:{id:1,planDate:'2026-09-22',checkpoint:{cycle:1,dueAt:now,phase:'weekend',roulette:{done:true}}},deadline:now+200000}),/lease lost/);
});

test('roulette and persisted window refresh alternate so neither saved set can starve',async()=>{
  const now=Date.parse('2026-09-22T10:00:00Z'),snapshot='2026-09-22T03:30:00Z',calls=[];
  const roulette={origin:'BER',dest:'BCN',flight_type:'any',departure_at:'2026-10-10',return_at:'2026-10-17',rank:1,snapshot_at:snapshot};
  const window={observed_on:'2026-09-22',snapshot_at:snapshot,origin:'BER',market:'de',dest:'FCO',destination_id:'rome',flight_type:'any',
    departure_at:'2026-10-10',return_at:'2026-10-17',position:1,window_kind:'weekend',exact_observed_at:'2026-09-22T09:00:00Z',refresh_status:'fresh'};
  const db={from:table=>chain(table==='daily_origin_cheapest_pool'?[{snapshot_at:snapshot}]:table==='daily_window_candidate_epochs'?
      [{observed_on:'2026-09-22',snapshot_at:snapshot,contract_version:1,candidate_rows:1,exact_request_groups:1}]:[]),
    rpc:(name,args)=>{calls.push({name,args});return Promise.resolve({data:true,error:null});},storage:{from:()=>({})}};
  const plans=new Map(),store={args:()=>({p_owner:'o',p_token:1}),lease:async()=>true,runId:'r',plan:async(key,build)=>{
    if(plans.has(key))return plans.get(key);const value=key.includes('/roulette-')?{tickets:[roulette],allowedDests:['BCN'],replacements:{},snapshotAt:snapshot}:
      key.includes('/windowrefresh-')?{tickets:[window],groups:[[window]],setId:'daily-window:test',selectedAt:snapshot}:await build();plans.set(key,value);return value;}};
  const provider={request:async url=>{const u=new URL(url);return{kind:'ok',json:{success:true,data:[{origin:'BER',destination:u.searchParams.get('destination'),
    departure_at:'2026-10-10T06:00:00Z',return_at:'2026-10-17T20:00:00Z',price:100,transfers:1}]}};}};
  const adapters=createAdapters({db,store,provider,clock:()=>now});const base={cycle:1,dueAt:now,phase:'roulette',auditDone:true,
    roulette:{cycle:1,cursor:0,done:false,errors:0,snapshotAt:snapshot}};
  const a=await adapters.priority.step({job:{id:1,planDate:'2026-09-22',checkpoint:base},deadline:now+200000});
  assert.equal(a.checkpoint.phase,'weekend');
  const b=await adapters.priority.step({job:{id:1,planDate:'2026-09-22',checkpoint:a.checkpoint},deadline:now+200000});
  assert.equal(b.checkpoint.weekend.cursor,1);assert.ok(calls.some(c=>c.name==='collection_commit_window_candidate'));
});
