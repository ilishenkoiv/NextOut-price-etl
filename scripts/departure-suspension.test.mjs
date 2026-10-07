import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from './collection-adapters.mjs';
import { CollectionProvider } from './collection-provider.mjs';
import { mainPlan, tailPlan, fastPlan, catalogue } from './collection-planning.mjs';
import { ORIGINS_ALL, ORIGINS_CATALOGUE, SUSPENDED_DEPARTURES } from '../src/data/origins.js';
import { publishedSnapshotOrigins } from './snapshot-daily-origin-cheapest.mjs';
import { pointRefreshTickets } from './daily-selection-refresh.mjs';

const now=Date.parse('2026-10-07T12:00:00Z');
function fixture(plan,{lease=true,tableRows={},rpc}={}){
  const calls=[],urls=[];const before=JSON.stringify(plan);
  const chain=data=>new Proxy({}, {get:(_,key)=>key==='then'?Promise.resolve({data,error:null}).then.bind(Promise.resolve({data,error:null})):()=>chain(data)});
  const db={rpc:async(name,args)=>{calls.push({name,args});return rpc?rpc(name,args):{data:true,error:null};},from:table=>chain(tableRows[table]??[]),
    storage:{from:()=>({upload:async()=>({data:{},error:null})})}};
  const store={plan:async()=>plan,args:()=>({p_owner:'test',p_token:1}),lease:async()=>lease,runId:'1'};
  const provider={request:async url=>{urls.push(url);return{kind:'ok',json:{success:true,data:[]}};}};
  const adapters=createAdapters({db,store,provider,clock:()=>now});
  return{adapters,calls,urls,unchanged:()=>assert.equal(JSON.stringify(plan),before)};
}
const job=checkpoint=>({id:20732,planDate:'2026-10-06',startedAt:now-1000,checkpoint});

test('future plans and publication use 18 departures while catalogue and destinations remain',()=>{
  assert.equal(ORIGINS_CATALOGUE.length,22);assert.equal(ORIGINS_ALL.length,18);
  for(const origin of SUSPENDED_DEPARTURES){assert.ok(ORIGINS_CATALOGUE.includes(origin));assert.ok(!publishedSnapshotOrigins().has(origin));}
  const p=mainPlan({date:'2026-10-07',wave:43,prices:[],watches:[]});
  assert.ok(p.routes.every(r=>!SUSPENDED_DEPARTURES.includes(r.origin)));
  for(const code of ['AMS','LHR'])assert.ok(p.routes.some(r=>r.dest===code));
  assert.deepEqual(new Set(p.routes.map(r=>r.dest)),new Set(catalogue(43).map(d=>d.iata)));
  const tail=tailPlan({date:'2026-10-07',wave:0,windows:[],history:[],watches:[]});
  assert.ok(tail.routes.every(r=>!SUSPENDED_DEPARTURES.includes(r.origin)));
  const rows=SUSPENDED_DEPARTURES.map(origin=>({origin,dest:'ROM',departure_at:'2026-11-01',return_at:'2026-11-08',price:100,window_kind:'holiday'}));
  assert.equal(fastPlan({rows,watches:[],today:'2026-10-07'}).tickets.length,0);
});

test('admitted MAIN keeps object/order/total and resumes cursor; suspension is not price or empty evidence',async()=>{
  const plan={months:['2026-11'],routes:[{origin:'AMS',dest:'ROM'},{origin:'FRA',dest:'AMS'},{origin:'BTS',dest:'ROM'}],cellOrder:[1,0,2],breakKeys:[]};
  const f=fixture(plan);const cp={cursor:1,wave:43,errors:0,outcomes:{attempted:1,confirmedPrice:1,confirmedEmpty:0,unresolved:0,legacyUnclassified:0}};
  const result=await f.adapters.main.step({job:job(cp),deadline:now+200000});
  assert.equal(result.status,'done');assert.equal(result.checkpoint.cursor,3);assert.equal(result.checkpoint.total,3);
  assert.equal(result.checkpoint.wave,43);assert.equal(result.checkpoint.outcomes.attempted,1);
  assert.equal(result.checkpoint.outcomes.suspended,2);assert.equal(result.checkpoint.outcomes.confirmedEmpty,0);
  assert.deepEqual(result.checkpoint.suspendedCells,[0,2]);assert.equal(result.checkpoint.coverageComplete,false);
  assert.equal(f.urls.length,0);assert.equal(f.calls.length,0);f.unchanged();
});

test('suspended final cell still schedules active debt; suspended retry preserves unresolved evidence',async()=>{
  const plan={months:['2026-11'],routes:[{origin:'FRA',dest:'ROM'},{origin:'EIN',dest:'ROM'}],breakKeys:[]};
  const f=fixture(plan);let cp={cursor:1,wave:43,errors:2,unresolvedCells:[0],outcomes:{attempted:1,confirmedPrice:0,confirmedEmpty:0,unresolved:1,legacyUnclassified:0}};
  let result=await f.adapters.main.step({job:job(cp),deadline:now+200000});
  assert.equal(result.status,'yield');assert.deepEqual(result.checkpoint.retryQueue,[0]);assert.equal(f.urls.length,0);
  result=await f.adapters.main.step({job:job(result.checkpoint),deadline:now+200000});
  assert.equal(result.checkpoint.outcomes.confirmedEmpty,1);assert.equal(result.checkpoint.outcomes.suspended,1);assert.equal(result.checkpoint.coverageComplete,false);
  const g=fixture(plan);cp={cursor:2,wave:43,errors:2,unresolvedCells:[1],outcomes:{attempted:2,confirmedPrice:1,confirmedEmpty:0,unresolved:1,legacyUnclassified:0}};
  result=await g.adapters.main.step({job:job(cp),deadline:now+200000});
  assert.deepEqual(result.checkpoint.unresolvedCells,[1]);assert.deepEqual(result.checkpoint.retrySuspendedCells,[1]);
  assert.equal(result.checkpoint.outcomes.unresolved,1);assert.equal(result.checkpoint.retryAttempts??0,0);assert.equal(g.urls.length,0);g.unchanged();
});

test('admitted FAST/TAIL skip original units without freshness writes or reslicing',async()=>{
  for(const task of ['fast','tail']){
    const ticket={origin:'BTS',dest:'ROM',departure_at:'2026-11-01',return_at:'2026-11-08',flight_type:'direct'};
    const plan=task==='fast'?{tickets:[ticket]}:{routes:[{origin:'EIN',dest:'ROM'}],windows:[{start:ticket.departure_at,end:ticket.return_at,nights:7,kind:'holiday'}]};
    const f=fixture(plan);const r=await f.adapters[task].step({job:job({cursor:0,wave:43,errors:0}),deadline:now+200000});
    assert.equal(r.status,'done');assert.equal(r.checkpoint.suspended,task==='fast'?1:2);assert.equal(f.calls.length,0);assert.equal(f.urls.length,0);f.unchanged();
  }
});

test('provider blocks suspended origin before quota/lease/network but permits it as destination',async()=>{
  let requests=0;const p=new CollectionProvider({token:'test',lease:async()=>true,fetchImpl:async()=>{requests++;return new Response(JSON.stringify({success:true,data:[]}));}});
  for(const origin of SUSPENDED_DEPARTURES)assert.deepEqual(await p.request('https://api.travelpayouts.com/test?origin='+origin),{kind:'suspended'});
  assert.equal(p.requests,0);assert.equal(requests,0);
  await p.request('https://api.travelpayouts.com/test?origin=FRA&destination=AMS');assert.equal(requests,1);
});

test('point refresh retains suspended tickets without false misses, errors or confirmation',async()=>{
  const ticket={origin:'LHR',dest:'ROM',flight_type:'direct',departure_at:'2026-11-01',return_at:'2026-11-08'};
  const before=structuredClone(ticket);const r=await pointRefreshTickets([ticket],{provider:{request:()=>{throw Error('forbidden');}}});
  assert.equal(r.suspended,1);assert.equal(r.attempted,0);assert.equal(r.misses,0);assert.equal(r.errors,0);assert.equal(r.confirmed.size,0);assert.deepEqual(ticket,before);
});

test('lease loss forbids suspended MAIN advancement',async()=>{
  const f=fixture({months:['2026-11'],routes:[{origin:'AMS',dest:'ROM'}],breakKeys:[]},{lease:false});
  await assert.rejects(f.adapters.main.step({job:job({cursor:0,wave:43,errors:0}),deadline:now+200000}),/lease lost/);
});

test('admitted roulette and carousel keep snapshot/cursor membership and preserve tickets',async()=>{
  const ticket={origin:'EIN',dest:'ROM',flight_type:'direct',departure_at:'2026-11-01',return_at:'2026-11-08',updated_at:new Date(now).toISOString()};
  const snapshot='2026-10-07T04:00:00Z';
  const f=fixture({tickets:[ticket],snapshotAt:snapshot});
  let cp={cycle:20732,phase:'roulette',roulette:{cursor:0,errors:0,done:false,snapshotAt:snapshot,admittedAt:now}};
  let r=await f.adapters.priority.step({job:job(cp),deadline:now+200000});
  assert.equal(r.checkpoint.roulette.cursor,1);assert.equal(r.checkpoint.roulette.total,1);
  assert.equal(r.checkpoint.roulette.suspended,1);assert.equal(r.checkpoint.roulette.snapshotAt,snapshot);
  assert.equal(f.urls.length,0);assert.equal(f.calls.length,0);f.unchanged();
  const g=fixture({tickets:[ticket],groups:[[ticket]],setId:'old',selectedAt:snapshot},{tableRows:{daily_window_candidate_epochs:[{observed_on:'2026-10-07',snapshot_at:snapshot}]}});
  cp={cycle:20732,phase:'weekend',dueAt:now,roulette:{done:true},weekend:{day:'2026-10-07',dayId:1,cursor:0,done:false,errors:0,passStartedAt:now,snapshotAt:snapshot}};
  r=await g.adapters.priority.step({job:job(cp),deadline:now+200000});
  assert.equal(r.checkpoint.weekend.cursor,1);assert.equal(r.checkpoint.weekend.total,1);
  assert.equal(r.checkpoint.weekend.suspended,1);assert.equal(r.checkpoint.weekend.snapshotAt,snapshot);
  assert.equal(g.urls.length,0);assert.equal(g.calls.length,0);g.unchanged();
});

test('suspended feedback audit finishes honestly without calling provider or creating no-price evidence',async()=>{
  const f=fixture({}, {rpc:(name)=>({data:name==='claim_flight_price_audit'?[{feedback_id:'test',claim_token:'test',feedback:{origin_iata:'LHR',destination_iata:'ROM',depart_date:'2026-11-01',return_date:'2026-11-08',flight_type:'direct'}}]:true,error:null})});
  await f.adapters.priority.step({job:job({cycle:20732,phase:'audit',roulette:{done:true}}),deadline:now+200000});
  assert.equal(f.urls.length,0);const finish=f.calls.find(c=>c.name==='finish_flight_price_audit');
  assert.equal(finish.args.p_status,'error');assert.equal(finish.args.p_detail,'departure_suspended');assert.equal(finish.args.p_price,null);
});
