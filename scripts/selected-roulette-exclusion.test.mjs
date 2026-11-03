import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from './collection-adapters.mjs';

const now = Date.parse('2026-10-31T07:00:00Z'); // 08:00 Europe/Berlin
const ticket = { observed_on:'2026-10-31', snapshot_at:'2026-10-31T06:30:00Z', origin:'FRA', dest:'MAD',
  flight_type:'any', departure_at:'2026-11-20', return_at:'2026-11-24', rank:2, price:99, transfers:0, market:'de' };
const chain = data => new Proxy({}, { get:(_target,key) => key === 'then'
  ? Promise.resolve({ data, error:null }).then.bind(Promise.resolve({ data, error:null })) : () => chain(data) });

function harness(response, { control={enabled:true,generation:7,main12h_rollback:false}, lease=async()=>true } = {}) {
  const calls=[];
  const db={
    from(table) { return chain(table === 'selected_price_refresh_control' ? [control] : []); },
    rpc(name,args) { calls.push({name,args}); return Promise.resolve({data:true,error:null}); },
    storage:{from:()=>({})},
  };
  const store={args:()=>({p_owner:'owner',p_token:11}),lease,runId:'run',plan:async()=>({tickets:[ticket],snapshotAt:ticket.snapshot_at})};
  const provider={request:async()=>response};
  const checkpoint={cycle:1,dueAt:now,phase:'roulette',auditDone:true,
    roulette:{cycle:1,cursor:0,done:false,errors:0,admittedAt:now,snapshotAt:ticket.snapshot_at}};
  return { adapter:createAdapters({db,store,provider,clock:()=>now}).priority, calls, checkpoint };
}

async function selected(response, options) {
  const h=harness(response,options);
  const result=await h.adapter.step({job:{id:1,planDate:'2026-10-31',checkpoint:h.checkpoint},deadline:now+200_000});
  return { ...h, result };
}

test('fresh verified fare retains the fixed ticket through the fenced selected RPC', async () => {
  const previous=process.env.SELECTED_PRICE_REFRESH_CANDIDATE; process.env.SELECTED_PRICE_REFRESH_CANDIDATE='owner-manual';
  try {
    const response={kind:'ok',json:{success:true,data:[{origin:'FRA',destination:'MAD',departure_at:'2026-11-20T06:00:00Z',return_at:'2026-11-24T20:00:00Z',price:99,transfers:0}]}};
    const h=await selected(response);
    assert.equal(h.calls[0].name,'collection_commit_selected_roulette');
    assert.equal(h.calls[0].args.p_result.status,'found');
    assert.deepEqual(h.calls[0].args.p_result.revision,{visibility:'verified',reason:null});
  } finally { if(previous===undefined) delete process.env.SELECTED_PRICE_REFRESH_CANDIDATE; else process.env.SELECTED_PRICE_REFRESH_CANDIDATE=previous; }
});

test('every non-verified result excludes exactly its current-pool ticket; no alternate lookup is performed', async () => {
  const previous=process.env.SELECTED_PRICE_REFRESH_CANDIDATE; process.env.SELECTED_PRICE_REFRESH_CANDIDATE='owner-manual';
  try {
    for (const [response,status,reason] of [
      [{kind:'ok',json:{success:true,data:[]}}, 'no_result', 'confirmed_absent'],
      [{kind:'timeout'}, 'error', 'unconfirmed'],
      [{kind:'refused',refusal:'rate_limit'}, 'error', 'unconfirmed'],
    ]) {
      const h=await selected(response);
      assert.equal(h.calls.length,1);
      assert.equal(h.calls[0].name,'collection_commit_selected_roulette');
      assert.equal(h.calls[0].args.p_result.status,status);
      assert.deepEqual(h.calls[0].args.p_result.revision,{visibility:'excluded',reason});
    }
  } finally { if(previous===undefined) delete process.env.SELECTED_PRICE_REFRESH_CANDIDATE; else process.env.SELECTED_PRICE_REFRESH_CANDIDATE=previous; }
});

test('durable OFF retains legacy behavior and a lost lease cannot publish a stale-generation revision', async () => {
  const previous=process.env.SELECTED_PRICE_REFRESH_CANDIDATE; process.env.SELECTED_PRICE_REFRESH_CANDIDATE='owner-manual';
  try {
    const off=await selected({kind:'ok',json:{success:true,data:[]}},{control:{enabled:false,generation:7,main12h_rollback:false}});
    assert.equal(off.calls[0].name,'collection_commit_roulette');
    const h=harness({kind:'ok',json:{success:true,data:[]}},{lease:async()=>false});
    await assert.rejects(() => h.adapter.step({job:{id:1,planDate:'2026-10-31',checkpoint:h.checkpoint},deadline:now+200_000}),/lease lost/);
    assert.equal(h.calls.length,0);
  } finally { if(previous===undefined) delete process.env.SELECTED_PRICE_REFRESH_CANDIDATE; else process.env.SELECTED_PRICE_REFRESH_CANDIDATE=previous; }
});
