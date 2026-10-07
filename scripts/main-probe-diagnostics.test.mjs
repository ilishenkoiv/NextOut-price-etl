import test from 'node:test';
import assert from 'node:assert/strict';
import { createMainProbeDiagnostics, requiredProbeFailureReason, isTargetMainCell } from './main-probe-diagnostics.mjs';
import { CollectionProvider, CollectionYield } from './collection-provider.mjs';
import { createAdapters } from './collection-adapters.mjs';
const source='a'.repeat(40);
const context={jobId:20733,cellId:2501,origin:'HHN',dest:'FRA',departureMonth:'2026-11',returnMonth:'2026-11',variant:'direct'};

test('whitelist attribution discards arbitrary input and deduplicates cell/variant/window',()=>{
  const records=[];const d=createMainProbeDiagnostics({source,runId:'123',emit:r=>records.push(r)});
  d.record({...context,url:'https://secret',headers:{token:'secret'},error:'secret',body:'secret'},'HTTP_CLIENT_ERROR',400);
  d.record(context,'INVALID_JSON',200);d.record({...context,variant:'any'},'DATA_NOT_ARRAY',200);
  d.record({...context,jobId:20732},'HTTP_CLIENT_ERROR',400);d.record({...context,dest:'DUS'},'HTTP_CLIENT_ERROR',400);
  d.record({...context,origin:'https://secret'},'HTTP_CLIENT_ERROR',400);d.record({...context,returnMonth:'secret'},'HTTP_CLIENT_ERROR',400);
  d.record({...context,returnMonth:'2026-12'},'secret arbitrary error',400);d.flush();
  assert.equal(records.length,2);assert.equal(records[0].source,source);assert.equal(records[0].runId,'123');
  assert.equal(records[0].jobId,20733);assert.equal(records[0].cellId,2501);assert.equal(records[0].httpStatus,400);
  assert.deepEqual(Object.keys(records[0]),['event','source','runId','jobId','cellId','origin','dest','departureMonth','returnMonth','variant','httpStatus','reason']);
  assert.ok(!JSON.stringify(records).includes('secret'));
});

test('route filter covers all twelve existing month cells and excludes other jobs/routes/invalid IDs',()=>{
  const records=[];const d=createMainProbeDiagnostics({source,runId:'123',emit:r=>records.push(r)});
  const months=['2026-11','2026-12','2027-01','2027-02','2027-03','2027-04'];
  for(let mi=0;mi<months.length;mi++)for(const [ri,origin,dest] of [[2501,'HHN','FRA'],[219,'NRN','DUS']]){
    const cellId=ri+mi*2727;
    assert.equal(isTargetMainCell(20733,cellId,origin,dest),true);
    d.record({...context,cellId,origin,dest,departureMonth:months[mi],returnMonth:months[mi]},'HTTP_CLIENT_ERROR',400);
  }
  assert.equal(records.length,12);assert.ok(records.some(r=>r.cellId===219));assert.ok(records.some(r=>r.cellId===2501));assert.ok(records.some(r=>r.cellId===2946));
  for(const [job,id,origin,dest] of [[20732,2501,'HHN','FRA'],[20734,2501,'HHN','FRA'],[20733,2501,'FRA','HHN'],[20733,2501,'HHN','DUS'],[20733,2501,'NRN','FRA'],[20733,-1,'HHN','FRA'],[20733,16362,'HHN','FRA'],[20733,1.5,'HHN','FRA']])
    assert.equal(isTargetMainCell(job,id,origin,dest),false);
});
test('24 records maximum and one final suppression summary; duplicate failures do not inflate suppression',()=>{
  const records=[];const d=createMainProbeDiagnostics({source,runId:'123',emit:r=>records.push(r)});
  for(let i=0;i<30;i++){const c={...context,returnMonth:`${2027+Math.floor(i/12)}-${String(i%12+1).padStart(2,'0')}`};d.record(c,'NETWORK_FAILURE',null);d.record(c,'NETWORK_FAILURE',null);}
  assert.equal(records.length,24);d.flush();d.flush();assert.equal(records.length,25);
  assert.deepEqual(records[24],{event:'main_required_probe_suppression',source,runId:'123',jobId:20733,emitted:24,suppressed:6,limit:24});
});
test('source/run/status/reason cannot carry arbitrary secrets and logging exceptions are inert',()=>{
  const records=[];const d=createMainProbeDiagnostics({source:'token-secret',runId:'header-secret',emit:r=>records.push(r)});
  d.record(context,'NETWORK_FAILURE','body-secret');d.flush();assert.equal(records[0].source,null);assert.equal(records[0].runId,null);assert.equal(records[0].httpStatus,null);
  assert.ok(!JSON.stringify(records).includes('secret'));
  const broken=createMainProbeDiagnostics({emit:()=>{throw Error('secret');}});assert.doesNotThrow(()=>broken.record(context,'INVALID_JSON',200));
});
test('classification reasons distinguish HTTP, transport, malformed body and genuine empty results',()=>{
  const cases=[[{kind:'error',status:400},'HTTP_CLIENT_ERROR'],[{kind:'refused',refusal:'tooMany'},'RATE_LIMIT'],[{kind:'refused',refusal:'server'},'HTTP_SERVER_ERROR'],
    [{kind:'refused',refusal:'network'},'NETWORK_FAILURE'],[{kind:'ok',json:{success:false,data:[]}},'SUCCESS_NOT_TRUE'],[{kind:'ok',json:{success:true,data:{}}},'DATA_NOT_ARRAY'],[{kind:'ok',json:{success:true,data:[]}},null],[{kind:'ok',json:{success:'truthy',data:[]}},null]];
  for(const [r,reason] of cases)assert.equal(requiredProbeFailureReason(r),reason);
});
test('provider observation does not change requests, pacing, backoff, boundary or lease refusal',async()=>{
  for(const mode of ['ok','400','invalid-json','429','network','lease']){
    async function run(observe){let now=0,calls=0,leases=0;const starts=[],seen=[];
      const p=new CollectionProvider({token:'secret',clock:()=>now,sleep:async ms=>{now+=ms;},lease:async()=>{leases++;return mode!=='lease';},fetchImpl:async()=>{calls++;starts.push(now);now+=50;
        if(mode==='network')throw Error('secret');if(mode==='429')return new Response('',{status:429,headers:{'Retry-After':'60'}});
        if(mode==='400')return new Response('secret',{status:400});if(mode==='invalid-json')return new Response('secret');return new Response('{"success":true,"data":[]}');}});
      let result,error;try{result=await p.request('https://api.travelpayouts.com/test?origin=HHN&token=secret',30000,observe?(status,reason)=>{seen.push({status,reason});}:null);}catch(e){error=e instanceof CollectionYield?e.reason:'lease';}
      return{accounting:{calls,starts,leases,now,requests:p.requests,next:[...p.nextByMethod],blocked:[...p.blockedByMethod],result,error},seen};}
    const off=await run(false),on=await run(true);assert.deepEqual(on.accounting,off.accounting,mode);
    if(mode==='invalid-json')assert.ok(on.seen.some(x=>x.reason==='INVALID_JSON'&&x.status===200));
    if(mode==='429')assert.equal(on.accounting.calls,1);if(mode==='lease')assert.equal(on.accounting.calls,0);
  }
});
test('required-probe attribution has original months/variant and does not alter checkpoint outcomes',async()=>{
  async function run(enabled){const records=[];let now=100000;const calls=[],urls=[];
    const diagnostics=createMainProbeDiagnostics({source,runId:'456',emit:enabled?r=>records.push(r):()=>{}});
    const plan={months:['2026-11'],routes:Array.from({length:2502},()=>({origin:'FRA',dest:'ROM',key:'FRA|ROM'})),breakKeys:[]};plan.routes[2501]={origin:'HHN',dest:'FRA',key:'HHN|FRA'};
    const chain=data=>new Proxy({}, {get:(_,key)=>key==='then'?Promise.resolve({data,error:null}).then.bind(Promise.resolve({data,error:null})):()=>chain(data)});
    const db={rpc:async(name,args)=>{calls.push({name,args});return{data:true,error:null};},from:()=>chain([]),storage:{from:()=>({upload:async()=>({data:{},error:null})})}};
    const provider=new CollectionProvider({token:'secret',clock:()=>now,sleep:async ms=>{now+=ms;},lease:async()=>true,fetchImpl:async url=>{urls.push(url);now+=8000;return new Response('',{status:400});}});
    provider.mainProbeDiagnostics=diagnostics;
    const store={plan:async()=>plan,args:()=>({p_owner:'test',p_token:1}),lease:async()=>true,runId:'456'};
    const main=createAdapters({db,store,provider,clock:()=>now}).main;
    const initial={cursor:2501,wave:43,errors:0,outcomes:{attempted:2501,confirmedPrice:2501,confirmedEmpty:0,unresolved:0,legacyUnclassified:0}};
    const r=await main.step({job:{id:20733,planDate:'2026-10-07',startedAt:0,checkpoint:initial},deadline:300000});diagnostics.flush();
    return{accounting:{result:r,calls,urls,requests:provider.requests,now,next:[...provider.nextByMethod]},records};}
  const off=await run(false),on=await run(true);assert.deepEqual(on.accounting,off.accounting);
  assert.equal(on.accounting.requests,4);assert.equal(on.accounting.result.status,'yield');assert.equal(on.accounting.result.checkpoint.outcomes.unresolved,1);
  assert.equal(on.accounting.result.checkpoint.cursor,2502);assert.equal(on.records.length,4);
  assert.deepEqual(on.records.map(r=>[r.variant,r.departureMonth,r.returnMonth]),[['direct','2026-11','2026-11'],['direct','2026-11','2026-12'],['any','2026-11','2026-11'],['any','2026-11','2026-12']]);
  assert.ok(on.records.every(r=>r.jobId===20733&&r.cellId===2501&&r.origin==='HHN'&&r.dest==='FRA'&&r.runId==='456'&&r.httpStatus===400));
});
