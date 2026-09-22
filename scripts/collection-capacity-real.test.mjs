import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from './collection-adapters.mjs';
import { CollectionYield } from './collection-provider.mjs';
import { SequentialSchedule, freshScheduleState, CYCLE_MS, PRIORITY_MAX_CYCLE_MS } from './collection-schedule.mjs';

const ticket=(i)=>({origin:'FRA',dest:`D${i}`,flight_type:i%2?'direct':'any',departure_at:'2027-01-10',return_at:'2027-01-17',rank:i+1,
  nights:7,window_kind:'weekend',updated_at:'2026-09-20T00:00:00Z'});
function chain(data,advance){return new Proxy({}, {get:(_,key)=>{if(key==='then'){const p=Promise.resolve().then(()=>{advance();return{data,error:null};});return p.then.bind(p);}return()=>chain(data,advance);}});}

function harness({latencyMs,roulette=220,windows=1205}){
  let now=7*60000;const dbMs=20;const advanceDb=()=>{now+=dbMs;};const cache=new Map();
  const db={from:()=>chain([],advanceDb),rpc:(name)=>{advanceDb();return Promise.resolve({data:name==='claim_flight_price_audit'?[]:true,error:null});},
    storage:{from:()=>({upload:async()=>{advanceDb();return{data:{},error:null};},list:async()=>({data:[],error:null}),remove:async()=>({data:{},error:null})})}};
  const store={owner:'o',token:1,runId:'r',args:()=>({p_owner:'o',p_token:1}),lease:async()=>true,
    save:async()=>{advanceDb();},plan:async(key,build)=>{
      if(cache.has(key))return cache.get(key);let value;
      if(key.includes('/roulette-'))value={tickets:Array.from({length:roulette},(_,i)=>ticket(i))};
      else if(key.includes('/windowrefresh-'))value={day:'1970-01-01',setId:'window-consumer:test',selectedAt:new Date(now).toISOString(),tickets:Array.from({length:windows},(_,i)=>ticket(i+500))};
      else if(key.includes('/main-'))value={months:['2027-01'],routes:Array.from({length:50},(_,i)=>({origin:'FRA',dest:`M${i}`,stops:0,key:`FRA|M${i}`})),breakKeys:[]};
      else if(key.includes('/fast-'))value={tickets:[]};else if(key.includes('/tail-'))value={routes:[],windows:[]};else value=await build();
      cache.set(key,value);return value;
    }};
  const provider={requests:0,request:async(input,deadline)=>{
    if(now+latencyMs+1000>=deadline)throw new CollectionYield('fake provider boundary');
    now+=latencyMs;provider.requests++;const u=new URL(input);const dep=u.searchParams.get('departure_at')||u.searchParams.get('month')?.slice(0,7)||'2027-01';
    const day=dep.length===7?dep+'-10':dep;const ret=u.searchParams.get('return_at');const retDay=ret?.length===7?ret+'-17':ret||'2027-01-17';
    return{kind:'ok',json:{success:true,data:[{origin:u.searchParams.get('origin'),destination:u.searchParams.get('destination'),
      departure_at:day+'T06:00:00Z',return_at:retDay+'T20:00:00Z',price:100,transfers:u.searchParams.get('direct')==='true'?0:1}]}};
  }};
  let engine;const adapters=createAdapters({db,store,provider,clock:()=>now,getState:()=>engine?.state,wave:0});
  engine=new SequentialSchedule({state:freshScheduleState(),clock:()=>now,lease:()=>store.lease(),save:s=>store.save(s),handlers:adapters,stopAt:CYCLE_MS});
  return{engine,provider,get now(){return now;},setNow:v=>{now=v;}};
}

async function driveCycle(h,max=20000){let steps=0;while(h.now+1000<CYCLE_MS&&steps++<max){const before=h.now;const r=await h.engine.tick();if(h.now===before)h.setNow(Math.min(CYCLE_MS,h.now+1000));if(r.status==='idle'&&h.now<CYCLE_MS)h.setNow(Math.min(CYCLE_MS,h.now+1000));}return steps;}

test('real priority adapter is capped per cycle; slow backlog keeps cursor while MAIN/TAIL/maintenance remain schedulable',async()=>{
  const h=harness({latencyMs:8000,roulette:220,windows:1205});await driveCycle(h);
  const state=h.engine.state;assert.ok((state.frame.prioritySpentMs??0)<=PRIORITY_MAX_CYCLE_MS+8000);
  assert.ok(state.jobs.priority.checkpoint.roulette.cursor>0&&state.jobs.priority.checkpoint.roulette.cursor<220,'slow roulette cursor is unfinished, not reset');
  assert.ok(state.jobs.main?.activeMs>0,'MAIN received work after the bounded priority overrun');
  assert.ok(state.jobs.tail,'TAIL was reached');assert.ok(state.jobs.maintenance,'maintenance was reached');

  const oldCursor=state.jobs.priority.checkpoint.roulette.cursor;h.setNow(CYCLE_MS+1000);h.engine.stopAt=2*CYCLE_MS;
  for(let i=0;i<20;i++)await h.engine.tick();
  assert.ok(h.engine.state.jobs.priority.checkpoint.roulette.cursor>=oldCursor,'new cycle resumes old priority cursor after its audit; no restart at zero');
});

test('real adapters with normal latency complete priority and advance MAIN with measured DB/provider time',async()=>{
  const h=harness({latencyMs:250,roulette:20,windows:20});await driveCycle(h);
  const p=h.engine.state.jobs.priority;assert.equal(p.done,true);assert.equal(p.checkpoint.weekend.cursor,20);
  assert.ok(p.checkpoint.weekend.fullCycleMs>0);assert.ok(h.engine.state.jobs.main.activeMs>0);assert.ok(h.provider.requests>=40);
});

test('429/backoff-style boundary yield checkpoints priority and lets lower work run instead of waiting forever',async()=>{
  const h=harness({latencyMs:250,roulette:5,windows:5});
  h.provider.request=async()=>{h.setNow(h.now+65000);throw new CollectionYield('429 Retry-After exceeds boundary');};
  const first=await h.engine.tick();assert.notEqual(first.task,'priority','the same scheduler tick advances to lower work after priority yields');
  assert.ok(first.task,'FAST/MAIN is schedulable while yielded priority waits for retry');
  assert.equal(h.engine.state.jobs.priority.checkpoint.roulette.cursor,0,'failed ticket did not advance');
});
