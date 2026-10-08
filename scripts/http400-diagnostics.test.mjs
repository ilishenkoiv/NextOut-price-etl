import test from 'node:test';
import assert from 'node:assert/strict';
import { readHttp400Error, safeProviderError, HTTP400_BODY_CAP } from './http400-diagnostics.mjs';
import { CollectionProvider } from './collection-provider.mjs';
import { createMainProbeDiagnostics } from './main-probe-diagnostics.mjs';
import { createAdapters } from './collection-adapters.mjs';
const body={error:{code:'ORIGIN_DESTINATION_SAME',message:'Origin and destination cannot be the same'}};
const opts=()=>({deadline:Date.now()+1000,secret:'private-token'});
const response=value=>new Response(typeof value==='string'?value:JSON.stringify(value),{status:400});
const safe={providerCode:body.error.code,providerMessage:body.error.message};
const context={jobId:20735,cellId:219,origin:'NRN',dest:'DUS',departureMonth:'2026-11',returnMonth:'2026-11',variant:'direct'};
test('extracts only approved error code/message shapes from capped JSON',async()=>{
  assert.deepEqual(await readHttp400Error(response({...body,token:'private-token',headers:{Authorization:'private-token'},url:'https://private.example'}),opts()),safe);
  assert.deepEqual(await readHttp400Error(response({error:'Invalid destination',error_code:'BAD_REQUEST'}),opts()),{providerCode:'BAD_REQUEST',providerMessage:'Invalid destination'});
});
test('rejects malformed JSON, invalid UTF-8, non-object and oversized bodies',async()=>{
  for(const b of ['not json','null','[]','x'.repeat(HTTP400_BODY_CAP+1)])assert.equal(await readHttp400Error(response(b),opts()),null);
  assert.equal(await readHttp400Error(new Response(new Uint8Array([255]),{status:400}),opts()),null);
});
test('oversized stream is cancelled without reading its next chunk',async()=>{
  let reads=0,cancelled=0;const r={status:400,body:{getReader:()=>({read:async()=>{reads++;return{done:false,value:new Uint8Array(4097)}},cancel:async()=>{cancelled++},releaseLock(){}})}};
  assert.equal(await readHttp400Error(r,opts()),null);assert.equal(reads,1);assert.equal(cancelled,1);
});
test('unavailable, locked and failed readers fall back without throwing',async()=>{
  for(const r of [{status:400},{status:400,get body(){throw Error('private-token')}},{status:400,body:{getReader(){throw Error('private-token')}}},{status:400,body:{getReader:()=>({read:async()=>{throw Error('private-token')},cancel:async()=>{},releaseLock(){}})}}])assert.equal(await readHttp400Error(r,opts()),null);
});
test('expired request deadline does not read a body',async()=>{
  let read=false;assert.equal(await readHttp400Error({status:400,body:{getReader(){read=true}}},{deadline:5,clock:()=>5}),null);assert.equal(read,false);
});
test('stalled body respects remaining deadline and is cancelled',async()=>{
  let cancelled=false;const started=performance.now();const r={status:400,body:{getReader:()=>({read:()=>new Promise(()=>{}),cancel:async()=>{cancelled=true},releaseLock(){}})}};
  assert.equal(await readHttp400Error(r,{deadline:Date.now()+20}),null);assert.equal(cancelled,true);assert.ok(performance.now()-started<500);
});
test('diagnostic parsing never exceeds original eight-second request budget',async()=>{
  let read=false,now=0;const p=new CollectionProvider({token:'private-token',clock:()=>now,lease:async()=>true,fetchImpl:async()=>{now=8000;return{status:400,ok:false,headers:new Headers(),body:{getReader(){read=true}}}}});
  assert.deepEqual(await p.request('https://api.travelpayouts.com/aviasales/v3/prices_for_dates?origin=HHN&destination=FRA',30000,()=>{}),{kind:'error',status:400});assert.equal(read,false);
});
test('sensitive/unknown text is omitted rather than logged or truncated',()=>{
  for(const text of ['token private-token','Authorization Bearer abc','https://secret.example/path?token=abc','person@example.com','eyJabc.def.ghi','Invalid origin private-token','Invalid origin SECRET','Invalid origin 123456789','Invalid origin\nAuthorization','Invalid origin C:/private/path'])assert.equal(safeProviderError({message:text},'private-token'),null);
  assert.equal(safeProviderError({code:'PRIVATE_TOKEN'},'private-token'),null);
  assert.equal(safeProviderError({message:'Invalid origin'},'origin'),null);
  assert.equal(safeProviderError({message:'Invalid origin '.repeat(20)}),null);
  assert.deepEqual(safeProviderError({code:'BAD_REQUEST',message:'https://secret.example'}),{providerCode:'BAD_REQUEST'});
});
test('transport observes safe fields only and preserves error/status and request count',async()=>{
  let requests=0;const seen=[];const p=new CollectionProvider({token:'private-token',lease:async()=>true,fetchImpl:async()=>{requests++;return response(body)}});
  const r=await p.request('https://api.travelpayouts.com/aviasales/v3/prices_for_dates?origin=HHN&destination=FRA&token=private-token',Date.now()+30000,(...x)=>seen.push(x));
  assert.deepEqual(r,{kind:'error',status:400});assert.equal(requests,1);assert.equal(p.requests,1);assert.deepEqual(seen,[[400,'HTTP_CLIENT_ERROR',safe]]);
});
test('non-target routes, absent observers and other statuses never read diagnostic bodies',async()=>{
  for(const [origin,dest,status,observer] of [['FRA','MAD',400,()=>{}],['HHN','FRA',400,null],['HHN','FRA',403,()=>{}]]){
    let reads=0;const p=new CollectionProvider({token:'private-token',lease:async()=>true,fetchImpl:async()=>({status,ok:false,headers:new Headers(),body:{getReader(){reads++;throw Error('must not read')}}})});
    assert.deepEqual(await p.request('https://api.travelpayouts.com/test?origin='+origin+'&destination='+dest,Date.now()+30000,observer),{kind:'error',status});assert.equal(reads,0);
  }
});
test('malformed HTTP400 diagnostics and throwing observer preserve outcomes',async()=>{
  const p=new CollectionProvider({token:'private-token',lease:async()=>true,fetchImpl:async()=>response('bad JSON')});
  assert.deepEqual(await p.request('https://api.travelpayouts.com/test?origin=HHN&destination=FRA',Date.now()+30000,()=>{throw Error('private-token')}),{kind:'error',status:400});assert.equal(p.requests,1);
});
test('new route-only channel accepts later jobs, revalidates fields, deduplicates and caps at 24',()=>{
  const records=[];const d=createMainProbeDiagnostics({source:'a'.repeat(40),runId:'123',emit:r=>records.push(r)});
  d.recordProviderError({...context,headers:'secret',url:'secret'},safe);d.recordProviderError(context,safe);
  d.recordProviderError({...context,origin:'FRA'},safe);d.recordProviderError(context,{providerMessage:'private-token'});
  for(let i=0;i<40;i++)d.recordProviderError({...context,cellId:i},safe);
  assert.equal(records.length,24);assert.equal(records[0].jobId,20735);assert.equal(records[0].reason,'HTTP_CLIENT_ERROR');assert.equal(records[0].event,'main_http400_provider_error');assert.ok(!JSON.stringify(records).includes('secret'));
});
test('MAIN capture leaves rejected cells unresolved without extra calls or writes',async()=>{
  async function run(enabled){let now=100000;const records=[],calls=[],urls=[];
    const diagnostics=createMainProbeDiagnostics({source:'a'.repeat(40),runId:'123',emit:r=>records.push(r)});
    if(!enabled)diagnostics.recordProviderError=()=>{};
    const provider=new CollectionProvider({token:'private-token',clock:()=>now,sleep:async ms=>{now+=ms},lease:async()=>true,fetchImpl:async url=>{urls.push(url);return response(body)}});provider.mainProbeDiagnostics=diagnostics;
    const plan={months:['2026-11'],routes:[{origin:'HHN',dest:'FRA',key:'HHN|FRA'}],breakKeys:[]};
    const db={rpc:async(name,args)=>{calls.push({name,args});return{data:true,error:null}}};
    const store={plan:async()=>plan,args:()=>({p_owner:'test',p_token:1}),lease:async()=>true,runId:'123'};
    const result=await createAdapters({db,store,provider,clock:()=>now}).main.step({job:{id:20735,planDate:'2026-10-08',startedAt:now,checkpoint:null},deadline:300000});
    return{accounting:{result,calls,urls,requests:provider.requests,now,next:[...provider.nextByMethod]},records};
  }
  const off=await run(false),on=await run(true);assert.deepEqual(on.accounting,off.accounting);assert.equal(on.accounting.requests,4);assert.equal(on.accounting.calls.length,0);
  assert.deepEqual(on.accounting.result.checkpoint.outcomes,{attempted:1,confirmedPrice:0,confirmedEmpty:0,unresolved:1,legacyUnclassified:0});assert.deepEqual(on.accounting.result.checkpoint.unresolvedCells,[0]);assert.equal(on.records.length,4);
});

function readyReader({empty=false,workMs=0}) {
  let reads=0,cancelled=0,released=0;
  const reader={read:async()=>{
    reads++;const end=performance.now()+workMs;while(performance.now()<end){}
    return{done:false,value:new Uint8Array(empty?0:1)};
  },cancel:async()=>{cancelled++},releaseLock(){released++}};
  return{response:{status:400,body:{getReader:()=>reader}},facts:()=>({reads,cancelled,released})};
}
test('continuously ready empty chunks terminate at 32 without retaining buffers or awaiting timer',async()=>{
  const r=readyReader({empty:true});const start=performance.now();
  assert.equal(await readHttp400Error(r.response,{deadline:600,clock:()=>0}),null);
  const elapsed=performance.now()-start;
  assert.deepEqual(r.facts(),{reads:32,cancelled:1,released:1});assert.ok(elapsed<250);
});
test('continuously ready small chunks obey independent 250ms deadline before byte cap',async()=>{
  const r=readyReader({workMs:1});const start=performance.now();
  assert.equal(await readHttp400Error(r.response,{deadline:600,clock:()=>0}),null);
  const elapsed=performance.now()-start,{reads,cancelled,released}=r.facts();
  assert.ok(elapsed>=240&&elapsed<300,elapsed+'ms');assert.ok(reads<4096);assert.equal(cancelled,1);assert.equal(released,1);
});
test('ready chunks obey shorter original remaining deadline and clean up reader',async()=>{
  const r=readyReader({workMs:1});const start=performance.now();
  assert.equal(await readHttp400Error(r.response,{deadline:30,clock:()=>0}),null);
  const elapsed=performance.now()-start,{reads,cancelled,released}=r.facts();
  assert.ok(elapsed>=25&&elapsed<80,elapsed+'ms');assert.ok(reads<80);assert.equal(cancelled,1);assert.equal(released,1);
});
test('empty chunks interspersed before a valid body are ignored and cleanup still occurs',async()=>{
  let reads=0,cancelled=0,released=0;const bytes=new TextEncoder().encode(JSON.stringify(body));
  const r={status:400,body:{getReader:()=>({read:async()=>++reads<4?{done:false,value:new Uint8Array(0)}:reads===4?{done:false,value:bytes}:{done:true},cancel:async()=>{cancelled++},releaseLock(){released++}})}};
  assert.deepEqual(await readHttp400Error(r,opts()),safe);assert.equal(reads,5);assert.equal(cancelled,1);assert.equal(released,1);
});
