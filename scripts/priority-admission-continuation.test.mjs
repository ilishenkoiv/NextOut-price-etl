import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdapters} from './collection-adapters.mjs';
import {CollectionYield} from './collection-provider.mjs';
import {CYCLE_MS} from './collection-schedule.mjs';
import {originDueThisCycle} from './priority-market-schedule.mjs';

const SNAPSHOT='2026-09-28T03:30:00Z';
const settle=result=>({then:(ok,bad)=>Promise.resolve(result).then(ok,bad)});
const chain=data=>new Proxy({}, {get:(_,key)=>key==='then'
  ?Promise.resolve({data,error:null}).then.bind(Promise.resolve({data,error:null})):()=>chain(data)});
const rouletteTicket=(dest,rank)=>({observed_on:'2026-09-28',snapshot_at:SNAPSHOT,origin:'BER',dest,flight_type:'any',
  departure_at:'2026-11-10',return_at:'2026-11-17',rank,price:100+rank,transfers:1,market:'de'});
const windowTicket=(dest,position)=>({observed_on:'2026-09-28',snapshot_at:SNAPSHOT,origin:'BER',market:'de',dest,
  destination_id:dest.toLowerCase(),flight_type:'any',departure_at:'2026-11-10',return_at:'2026-11-17',position,
  window_kind:'weekend',exact_observed_at:'2026-09-28T03:30:00Z',refresh_status:'fresh'});

function withPilot(factory){
  const old=process.env.PRIORITY_MARKET_SCHEDULE;process.env.PRIORITY_MARKET_SCHEDULE='pilot';
  try{return factory();}finally{if(old===undefined)delete process.env.PRIORITY_MARKET_SCHEDULE;else process.env.PRIORITY_MARKET_SCHEDULE=old;}
}

function harness({clockRef,roulette=[],groups=[],request}={}){
  const calls=[],planKeys=[],requests=[];
  const db={from:table=>chain(table==='daily_origin_cheapest_pool'?[{snapshot_at:SNAPSHOT}]
    :table==='daily_window_candidate_epochs'?[{observed_on:'2026-09-28',snapshot_at:SNAPSHOT,contract_version:1,
      candidate_rows:groups.flat().length,exact_request_groups:groups.length}]:[]),
    rpc:(name,args)=>{calls.push({name,args});return name==='claim_flight_price_audit'?settle({data:[],error:null}):settle({data:true,error:null});},
    storage:{from:()=>({})}};
  const store={args:()=>({p_owner:'o',p_token:1}),lease:async()=>true,runId:'r',plan:async(key,build)=>{
    planKeys.push(key);
    if(key.includes('/roulette-'))return{tickets:roulette,snapshotAt:SNAPSHOT};
    if(key.includes('/windowrefresh-'))return{tickets:groups.flat(),groups,setId:`daily-window:${SNAPSHOT}`,selectedAt:SNAPSHOT};
    return build();
  }};
  const provider={request:async url=>{requests.push(url);if(request)return request(url,requests.length);
    const u=new URL(url);return{kind:'ok',json:{success:true,data:[{origin:'BER',destination:u.searchParams.get('destination'),
      departure_at:'2026-11-10T06:00:00Z',return_at:'2026-11-17T20:00:00Z',price:77,transfers:1}]}};}};
  const adapters=withPilot(()=>createAdapters({db,store,provider,clock:()=>clockRef.now}));
  return{adapters,calls,planKeys,requests};
}

test('Monday two-hour due roulette pass continues the same admitted set in the later non-due cycle',async()=>{
  const due=Date.parse('2026-09-28T06:00:00Z'); // Monday 08:00 Berlin: 2h cadence due
  const clockRef={now:due},tickets=[rouletteTicket('AMS',1),rouletteTicket('ATH',2)];
  const h=harness({clockRef,roulette:tickets});const cycle=Math.floor(due/CYCLE_MS);
  const first=await h.adapters.priority.step({job:{id:cycle,startedAt:due,planDate:'2026-09-28',checkpoint:{cycle,dueAt:due,
    phase:'roulette',auditDone:true,roulette:{cycle,cursor:0,done:false,errors:0,snapshotAt:SNAPSHOT}}},deadline:due+200000});
  assert.equal(first.checkpoint.roulette.cursor,1);assert.equal(first.checkpoint.roulette.admittedAt,due);
  clockRef.now=due+CYCLE_MS;assert.equal(originDueThisCycle(clockRef.now,'BER'),false);
  const second=await h.adapters.priority.step({job:{id:cycle+1,startedAt:clockRef.now,planDate:'2026-09-28',checkpoint:first.checkpoint},deadline:clockRef.now+200000});
  assert.equal(second.checkpoint.roulette.admittedAt,due);assert.equal(second.checkpoint.roulette.snapshotAt,SNAPSHOT);
  assert.equal(second.checkpoint.roulette.cursor,2);assert.equal(second.checkpoint.roulette.total,2);
  assert.deepEqual(h.requests.map(url=>new URL(url).searchParams.get('destination')),['AMS','ATH']);
  assert.equal(new Set(h.planKeys.filter(key=>key.includes('/roulette-'))).size,1,'membership plan identity is not rebuilt');
});

test('Sunday two-hour due window pass continues its admitted groups after rollover into a non-due cycle',async()=>{
  const due=Date.parse('2026-09-27T06:00:00Z'); // Sunday 08:00 Berlin: daytime 2h due
  const clockRef={now:due},groups=[[windowTicket('FCO',1)],[windowTicket('LIS',2)]];
  const h=harness({clockRef,groups});const cycle=Math.floor(due/CYCLE_MS);
  const first=await h.adapters.priority.step({job:{id:cycle,startedAt:due,planDate:'2026-09-27',checkpoint:{cycle,dueAt:due,
    phase:'weekend',auditDone:true,roulette:{cycle,cursor:0,total:0,done:true,errors:0,admittedAt:due}}},deadline:due+200000});
  assert.equal(first.checkpoint.weekend.cursor,1);assert.equal(first.checkpoint.weekend.admittedAt,due);
  clockRef.now=due+CYCLE_MS;assert.equal(originDueThisCycle(clockRef.now,'BER'),false);
  const rollover=await h.adapters.priority.step({job:{id:cycle+1,startedAt:clockRef.now,planDate:'2026-09-27',checkpoint:first.checkpoint},deadline:clockRef.now+200000});
  const second=await h.adapters.priority.step({job:{id:cycle+1,startedAt:clockRef.now,planDate:'2026-09-27',checkpoint:rollover.checkpoint},deadline:clockRef.now+200000});
  assert.equal(second.checkpoint.weekend.admittedAt,due);assert.equal(second.checkpoint.weekend.setId,`daily-window:${SNAPSHOT}`);
  assert.equal(second.checkpoint.weekend.cursor,2);assert.equal(second.checkpoint.weekend.total,2);
  assert.deepEqual(h.requests.map(url=>new URL(url).searchParams.get('destination')),['FCO','LIS']);
});

test('Sunday admission respects both two-hour daytime and hourly evening schedules',()=>{
  assert.equal(originDueThisCycle(Date.parse('2026-09-27T06:00:00Z'),'BER'),true);  // 08:00 Berlin, 2h
  assert.equal(originDueThisCycle(Date.parse('2026-09-27T06:30:00Z'),'BER'),false); // 08:30 Berlin
  assert.equal(originDueThisCycle(Date.parse('2026-09-27T12:00:00Z'),'BER'),true);  // 14:00 Berlin, hourly
  assert.equal(originDueThisCycle(Date.parse('2026-09-27T12:30:00Z'),'BER'),false); // 14:30 Berlin
  assert.equal(originDueThisCycle(Date.parse('2026-09-27T13:00:00Z'),'BER'),true);  // 15:00 Berlin
});

test('yielded roulette checkpoint survives process restart and continues with its original admission time',async()=>{
  const due=Date.parse('2026-09-28T06:00:00Z'),clockRef={now:due},tickets=[rouletteTicket('AMS',1)];
  const yielding=harness({clockRef,roulette:tickets,request:async()=>{throw new CollectionYield('boundary')}});
  const cycle=Math.floor(due/CYCLE_MS),job={id:cycle,startedAt:due,planDate:'2026-09-28',checkpoint:{cycle,dueAt:due,
    phase:'roulette',auditDone:true,roulette:{cycle,cursor:0,done:false,errors:0,snapshotAt:SNAPSHOT}}};
  const yielded=await yielding.adapters.priority.step({job,deadline:due+200000});
  assert.equal(yielded.status,'yield');assert.equal(yielded.checkpoint.roulette.cursor,0);assert.equal(yielded.checkpoint.roulette.admittedAt,due);
  clockRef.now=due+CYCLE_MS;
  const restarted=harness({clockRef,roulette:tickets});
  const resumed=await restarted.adapters.priority.step({job:{...job,id:cycle+1,startedAt:clockRef.now,checkpoint:structuredClone(yielded.checkpoint)},deadline:clockRef.now+200000});
  assert.equal(resumed.checkpoint.roulette.admittedAt,due);assert.equal(resumed.checkpoint.roulette.cursor,1);
  assert.equal(restarted.requests.length,1);
});

test('a fresh non-due cycle admits empty effective roulette/window sets and issues zero requests',async()=>{
  const nonDue=Date.parse('2026-09-28T06:30:00Z'),clockRef={now:nonDue};
  const h=harness({clockRef,roulette:[rouletteTicket('AMS',1)],groups:[[windowTicket('FCO',1)]]});
  const cycle=Math.floor(nonDue/CYCLE_MS),job={id:cycle,startedAt:nonDue,planDate:'2026-09-28',checkpoint:{cycle,dueAt:nonDue,
    phase:'roulette',auditDone:true,roulette:{cycle,cursor:0,done:false,errors:0}}};
  const rouletteDone=await h.adapters.priority.step({job,deadline:nonDue+200000});
  const windowDone=await h.adapters.priority.step({job:{...job,checkpoint:rouletteDone.checkpoint},deadline:nonDue+200000});
  assert.equal(rouletteDone.checkpoint.roulette.total,0);assert.equal(rouletteDone.checkpoint.roulette.done,true);
  assert.equal(windowDone.checkpoint.weekend.total,0);assert.equal(windowDone.checkpoint.weekend.done,true);
  assert.equal(h.requests.length,0);assert.equal(h.calls.filter(call=>call.name.startsWith('collection_commit_')).length,0);
});
