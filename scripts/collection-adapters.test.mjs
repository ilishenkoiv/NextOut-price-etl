import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from './collection-adapters.mjs';

function fixture(plan,response){
  const calls=[];
  const chain=data=>new Proxy({}, {get:(_,key)=>key==='then'?Promise.resolve({data,error:null}).then.bind(Promise.resolve({data,error:null})):()=>chain(data)});
  const db={rpc:(name,args)=>{calls.push({name,args});return Promise.resolve({data:true,error:null});},
    from:()=>chain([]),storage:{from:()=>({upload:async()=>({data:{},error:null})})}};
  const store={args:()=>({p_owner:'test-owner',p_token:1}),lease:async()=>true,plan:async()=>plan,runId:'123'};
  let requests=0;
  const provider={request:async url=>{requests++;return response(requests,url);}};
  return{adapters:createAdapters({db,store,provider,clock:()=>100000,wave:10}),calls,get requests(){return requests;}};
}
const job={id:1,planDate:'2026-09-16',startedAt:100000,checkpoint:null};
const mainPlan={months:['2027-01'],routes:[{origin:'FRA',dest:'MAD',stops:0,key:'FRA|MAD'}],breakKeys:[]};
const offer={departure_at:'2027-01-10T08:00:00Z',return_at:'2027-01-17T09:00:00Z',price:123,transfers:0};

test('real main parser and selector commit a complete route cell once',async()=>{
  const f=fixture(mainPlan,()=>({kind:'ok',json:{success:true,data:[offer]}}));
  const result=await f.adapters.main.step({job,deadline:200000});
  assert.equal(f.requests,2);
  assert.equal(f.calls.length,1);assert.equal(f.calls[0].name,'collection_commit_main');
  assert.equal(f.calls[0].args.p_price.direct,123);
  assert.equal(f.calls[0].args.p_price.market,'de');
  assert.equal(f.calls[0].args.p_price.price_source.round_trip_validated,true);
  assert.equal(f.calls[0].args.p_offers.length,1);
  assert.equal(result.checkpoint.cursor,1);
  assert.equal(result.checkpoint.stage,'snapshot');
});
test('empty natural type uses both alternative return windows without inventing a direct fare',async()=>{
  const f=fixture(mainPlan,n=>({kind:'ok',json:{success:true,data:n<=2?[]:[{...offer,transfers:1}]}}));
  await f.adapters.main.step({job,deadline:200000});
  assert.equal(f.requests,4);
  assert.equal(f.calls[0].args.p_price.direct,null);
  assert.equal(f.calls[0].args.p_price.any_stops,123);
});
test('inconclusive main response records a gap without overwriting the old price',async()=>{
  const f=fixture(mainPlan,()=>({kind:'refused',refusal:'server'}));
  const result=await f.adapters.main.step({job,deadline:200000});
  assert.equal(f.calls.length,0);assert.equal(result.checkpoint.errors,1);
});
test('an empty direct cache plus failed alternatives cannot erase an old connecting fare',async()=>{
  const f=fixture(mainPlan,n=>n<=2?{kind:'ok',json:{success:true,data:[]}}:{kind:'refused',refusal:'server'});
  const result=await f.adapters.main.step({job,deadline:200000});
  assert.equal(f.calls.length,0);assert.equal(result.checkpoint.errors,1);
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
test('a saved wave is retained when the next runner has a different rollout setting',async()=>{
  const f=fixture(mainPlan,()=>({kind:'ok',json:{success:true,data:[offer]}}));
  const result=await f.adapters.main.step({job:{...job,checkpoint:{cursor:0,errors:0,wave:0}},deadline:200000});
  assert.equal(result.checkpoint.wave,0);
});
test('malformed roulette data preserves the existing offer and advances diagnostic progress',async()=>{
  const ticket={origin:'FRA',dest:'MAD',flight_type:'direct',departure_at:'2027-01-10',return_at:'2027-01-17'};
  const f=fixture({tickets:[ticket]},()=>({kind:'ok',json:{success:true,data:{}}}));
  const result=await f.adapters.maintenance.step({job:{...job,checkpoint:{turn:1}},deadline:200000});
  assert.equal(f.calls[0].name,'collection_commit_roulette');
  assert.equal(f.calls[0].args.p_result.status,'error');
  assert.equal(result.checkpoint.roulette.errors,1);
});
