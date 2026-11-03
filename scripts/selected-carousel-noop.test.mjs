import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from './collection-adapters.mjs';

function chain(data){return new Proxy({}, {get:(_,key)=>key==='then'
  ? Promise.resolve({data,error:null}).then.bind(Promise.resolve({data,error:null}))
  : ()=>chain(data)});}

test('selected-carousel timeout atomically commits the freshest factual exact-date fallback',async()=>{
  const previous=process.env.SELECTED_PRICE_REFRESH_CANDIDATE;
  process.env.SELECTED_PRICE_REFRESH_CANDIDATE='owner-manual';
  try{
    const now=Date.parse('2026-10-31T08:00:00Z'); // 09:00 Europe/Berlin: selected refresh slot
    const snapshot='2026-10-31T03:30:00Z';
    const ticket={origin:'FRA',dest:'MAD',destination_id:'madrid',flight_type:'any',departure_at:'2026-11-14',return_at:'2026-11-16',
      position:1,window_kind:'weekend',snapshot_at:snapshot,exact_observed_at:snapshot,updated_at:snapshot};
    const commits=[];
    const rows={selected_price_refresh_control:[{enabled:true,generation:7,main12h_rollback:false}],
      daily_window_candidate_epochs:[{observed_on:'2026-10-31',snapshot_at:snapshot,contract_version:1,candidate_rows:1,exact_request_groups:1}],
      offers:[{origin:'FRA',flight_type:'any',dest:'LIS',destination_id:'lisbon',departure_at:'2026-11-14',return_at:'2026-11-16',price:88,updated_at:new Date(now-5*60_000).toISOString()}]};
    const db={from:table=>chain(rows[table]??[]),rpc:(name,args)=>{commits.push({name,args});return Promise.resolve({data:true,error:null});},storage:{from:()=>({})}};
    const plan={day:'2026-10-31',setId:'daily-window:test',selectedAt:snapshot,tickets:[ticket],groups:[[ticket]]};
    const store={args:()=>({p_owner:'test-owner',p_token:1}),lease:async()=>true,plan:async()=>plan,runId:'test'};
    let requests=0;
    const provider={request:async()=>{requests++;return{kind:'refused',refusal:'timeout'};}};
    const adapters=createAdapters({db,store,provider,clock:()=>now});
    const result=await adapters.priority.step({job:{id:1,planDate:'2026-10-31',startedAt:now,
      checkpoint:{cycle:1,dueAt:now,phase:'weekend',auditDone:true,roulette:{done:true}}},deadline:now+200000});
    assert.equal(requests,1,'the actual selected-carousel adapter path reaches the timeout');
    assert.equal(commits.length,1,'technical/unconfirmed selected-carousel outcome reaches the fenced revision RPC');
    assert.equal(commits[0].name,'collection_commit_selected_carousel');
    assert.equal(commits[0].args.p_result.status,'error');
    assert.equal(commits[0].args.p_result.outcome,'replaced');
    assert.equal(commits[0].args.p_result.replacement.dest,'LIS');
    assert.equal(result.checkpoint.weekend.errors,0,'the atomic fallback is a handled outcome');
  }finally{
    if(previous===undefined)delete process.env.SELECTED_PRICE_REFRESH_CANDIDATE;else process.env.SELECTED_PRICE_REFRESH_CANDIDATE=previous;
  }
});
