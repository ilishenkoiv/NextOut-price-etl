import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from './collection-adapters.mjs';
import { CollectionProvider, CollectionYield } from './collection-provider.mjs';
import { SequentialSchedule, freshScheduleState, prepareJob, CYCLE_MS, runBoundedMainAdvance, offCycleMainBudget } from './collection-schedule.mjs';
import { mainBoundaryStatus } from './main-continuation.mjs';

const start=Date.parse('2026-10-06T12:05:00Z');
const plan={months:['2027-01'],routes:['MAD','ROM','DUB'].map(dest=>({origin:'FRA',dest,key:'FRA|'+dest})),breakKeys:[]};
function fixture({mode='ok',lease=async()=>true,saveFailure=false}={}){
  let now=start,requests=0;const urls=[],commits=[],saves=[];
  const chain=data=>new Proxy({}, {get:(_,key)=>key==='then'?Promise.resolve({data,error:null}).then.bind(Promise.resolve({data,error:null})):()=>chain(data)});
  const db={rpc:async(name,args)=>{commits.push({name,args});return {data:true,error:null};},from:()=>chain([]),
    storage:{from:()=>({upload:async()=>({data:{},error:null})})}};
  const provider=new CollectionProvider({token:'test',clock:()=>now,sleep:async ms=>{now+=ms;},lease,
    fetchImpl:async url=>{requests++;urls.push(url);now+=8000;
      if(mode==='400' && requests===5)return new Response('',{status:400});
      if(mode==='body' && requests===5)return new Response(JSON.stringify({success:false,data:[]}));
      if(mode==='cancel' && requests===5)throw new CollectionYield('cancelled');
      if(mode==='429' && requests===5)return new Response('',{status:429,headers:{'Retry-After':'60'}});
      if(mode==='quota' && requests===5)return new Response(JSON.stringify({success:true,data:[]}),{headers:{'X-Rate-Limit':'100','X-Rate-Limit-Remaining':'0','X-Rate-Limit-Reset':'60'}});
      return new Response(JSON.stringify({success:true,data:[{departure_at:'2027-01-10T08:00:00Z',return_at:'2027-01-17T09:00:00Z',price:120,transfers:new URL(url).searchParams.get('direct')==='true'?0:1}]}));}});
  const store={plan:async()=>plan,args:()=>({p_owner:'test',p_token:1}),lease,runId:'1'};
  const adapters=createAdapters({db,store,provider,clock:()=>now,wave:0});
  const state=freshScheduleState();state.frame={cycle:Math.floor(start/CYCLE_MS),phase:2,spentMs:0,prioritySpentMs:0};
  const engine=new SequentialSchedule({state,clock:()=>now,lease,stopAt:start+25*60000,
    save:async s=>{if(saveFailure&&s.jobs.main?.checkpoint?.cursor>0)throw new Error('fenced save rejected');saves.push(structuredClone(s));},handlers:{main:adapters.main}});
  return {engine,adapters,provider,urls,commits,saves,clock:()=>now,get requests(){return requests;},advance:ms=>{now+=ms;}};
}

test('productive bounded exhaustion retains MAIN phase and durably resumes remaining allocation with incomplete replay',async()=>{
  const f=fixture();const first=await f.engine.tick();
  assert.equal(first.status,'progress');assert.equal(first.task,'main');
  assert.equal(f.engine.state.jobs.main.checkpoint.cursor,1);
  assert.equal(f.engine.state.frame.phase,2);assert.equal(f.engine.state.jobs.main.retryAt,0);
  assert.equal(f.saves.at(-1).jobs.main.checkpoint.cursor,1);
  const id=f.engine.state.jobs.main.id;const second=await f.engine.tick();
  assert.equal(second.status,'progress');assert.equal(f.engine.state.jobs.main.id,id);
  assert.equal(f.engine.state.jobs.main.checkpoint.cursor,2);
  assert.equal(new URL(f.urls[7]).searchParams.get('destination'),'ROM','partial second cell replays from its first mandatory probe');
  assert.equal(new URL(f.urls[7]).searchParams.get('direct'),'true');
  assert.equal(f.commits.filter(x=>x.name==='collection_commit_main').length,2);
});

test('zero-progress boundary or unknown yield keeps cooldown and stops the automated driver',async()=>{
  for(const reason of ['boundary','unavailable']){
    let now=start,calls=0;const engine=new SequentialSchedule({clock:()=>now,lease:async()=>true,save:async()=>{},
      handlers:{main:{maxUnitMs:90000,step:async()=>{calls++;now+=1000;return {status:mainBoundaryStatus({}, {cursor:0},reason),checkpoint:{cursor:0,total:3}};}}}});
    const r=await runBoundedMainAdvance({engine,stopAt:start+120000,clock:()=>now});
    assert.equal(calls,1);assert.equal(r.lastStatus,'idle');assert.ok(engine.state.jobs.main.retryAt>now);
  }
});

test('actual Retry-After and low-quota blocking after committed progress retain yield/cooldown',async()=>{
  for(const mode of ['429','quota']){
    const f=fixture({mode});const r=await f.engine.tick();
    assert.equal(r.status,'idle');assert.equal(f.engine.state.jobs.main.checkpoint.cursor,1);
    assert.ok(f.engine.state.jobs.main.retryAt>f.clock());assert.equal(f.requests,5);
    assert.equal((await f.engine.tick()).status,'idle');assert.equal(f.requests,5);
  }
});

test('technical probe errors never qualify as productive continuation',()=>{
  assert.equal(mainBoundaryStatus({cursor:0,errors:0},{cursor:1,errors:1},'boundary'),'yield');
  assert.equal(mainBoundaryStatus({cursor:0},{cursor:1},'backoff'),'yield');
  assert.equal(mainBoundaryStatus({cursor:0},{cursor:1}),'yield');
  assert.equal(mainBoundaryStatus({cursor:3,retryAttempts:0},{cursor:3,retryAttempts:1},'boundary'),'progress');
});

test('technical error before boundary after committed progress retains cooldown and partial-cell replay',async()=>{
  for(const mode of ['400','body']){
    const f=fixture({mode});const result=await f.engine.tick();
    const cp=f.engine.state.jobs.main.checkpoint;
    assert.equal(result.status,'idle',mode+' must yield despite the earlier committed cell');
    assert.equal(cp.cursor,1);assert.equal(cp.errors,0,'partial-cell error accounting remains deferred');
    assert.deepEqual(cp.outcomes,{attempted:1,confirmedPrice:1,confirmedEmpty:0,unresolved:0,legacyUnclassified:0});
    assert.equal(f.requests,7,'error in the second cell precedes a later required-request boundary');
    assert.ok(f.engine.state.jobs.main.retryAt>f.clock());
    assert.equal(f.commits.filter(x=>x.name==='collection_commit_main').length,1);
    assert.equal(f.commits.filter(x=>x.name==='collection_record_route_observation').length,1,
      'the incomplete second cell supplies no confirmed-empty or price-health evidence');
    assert.equal((await f.engine.tick()).status,'idle');assert.equal(f.requests,7);
    f.advance(60000);await f.engine.tick();
    assert.equal(new URL(f.urls[7]).searchParams.get('destination'),'ROM');
    assert.equal(new URL(f.urls[7]).searchParams.get('direct'),'true','both variants replay from the first required probe');
    assert.equal(f.engine.state.jobs.main.checkpoint.cursor,2);
    assert.equal(f.engine.state.jobs.main.checkpoint.errors,0,'replayed successful cell is accounted truthfully');
    assert.equal(f.commits.filter(x=>x.name==='collection_commit_main').length,2);
  }
});

test('lease loss and rejected fenced save stop continuation without another provider unit',async()=>{
  let live=true;const f=fixture({lease:async()=>live});await f.engine.tick();const count=f.requests;
  live=false;await assert.rejects(f.engine.tick(),/lease/);assert.equal(f.requests,count);
  const rejected=fixture({saveFailure:true});await assert.rejects(rejected.engine.tick(),/fenced save rejected/);
  assert.equal(rejected.requests,7);
});

test('cancellation thrown by an adapter still stops the scheduler',async()=>{
  const engine=new SequentialSchedule({clock:()=>start,lease:async()=>true,save:async()=>{},handlers:{main:{maxUnitMs:90000,step:async()=>{throw new Error('cancelled');}}}});
  await assert.rejects(engine.tick(),/cancelled/);
});

test('priority and maintenance preempt the next productive MAIN unit',async()=>{
  for(const task of ['priority','maintenance']){
    const f=fixture();await f.engine.tick();const count=f.requests;
    f.engine.handlers[task]={maxUnitMs:1000,isDue:()=>true,step:async()=>({status:'done',checkpoint:{}})};
    if(task==='priority')f.engine.state.jobs.priority.done=false;
    assert.equal((await f.engine.tick()).task,task);assert.equal(f.requests,count);
  }
});

test('natural MAIN completion creates a unique successor without altering the finished plan',async()=>{
  const f=fixture();let r;for(let i=0;i<5;i++){r=await f.engine.tick();if(r.status==='done')break;}
  assert.equal(r.status,'done');assert.equal(f.engine.state.completedMain,1);
  assert.equal(f.engine.state.completedMainCoverage,1);
  const completed=structuredClone(f.engine.state.jobs.main);
  const successor=prepareJob(f.engine.state,'main',f.clock());
  assert.equal(successor.id,completed.id+1);assert.equal(successor.checkpoint,null);
  assert.equal(prepareJob(f.engine.state,'main',f.clock()).id,successor.id);
  assert.equal(completed.checkpoint.cursor,3);
});

test('off-cycle safety margin, unit admission and session bound remain unchanged',async()=>{
  const f=fixture();const stopAt=offCycleMainBudget(start,{safetyMarginMs:90000,maxSessionMs:120000});
  f.engine.stopAt=stopAt;const r=await runBoundedMainAdvance({engine:f.engine,stopAt,clock:f.clock});
  assert.ok(f.clock()<=stopAt);assert.ok(r.ticks<=3);assert.equal(r.lastStatus,'idle');
  assert.equal(f.engine.state.jobs.main.checkpoint.cursor,1,'90-second admission prevents another unit inside the unchanged two-minute ceiling');
});
