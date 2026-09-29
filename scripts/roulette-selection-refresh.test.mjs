import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

process.env.SUPABASE_SERVICE_KEY??='test-service-key';
const {main:publishSnapshot,manualRecoveryMain,assertCompleteDailyRoulettePool}=await import('./snapshot-daily-origin-cheapest.mjs');
const {createAdapters}=await import('./collection-adapters.mjs');
const {capRefreshTickets,MAX_REFRESH_TICKETS}=await import('./refresh-roulette-prices.mjs');

const settle=result=>({then:(ok,bad)=>Promise.resolve(result).then(ok,bad)});
const destinations=['AMS','ATH','BCN','FCO','IST','LIS','PMI','PRG','VIE','ZRH'];
const offers=destinations.map((dest,index)=>({origin:'BER',market:'de',dest,flight_type:'any',price:100+index,
  departure_at:'2027-03-10',return_at:'2027-03-17',transfers:1,updated_at:'2027-01-05T06:00:00Z',price_source:null}));

function selectionDb({published=true,rows=offers}={}){
  const writes=[],reads=[];
  return{writes,reads,from(table){const chain={select(){return chain},gte(){return chain},gt(){return chain},order(){return chain},
    range(){reads.push(table);return settle({data:table==='offers'?rows:[],error:null})}};return chain},
    rpc(name,args){reads.push(name);writes.push({name,args});return settle({data:published,error:null})}};
}

test('daily owner publishes ten fixed ranked cities and force never asks SQL to replace the day',async()=>{
  const db=selectionDb();const result=await publishSnapshot({db,snapshotAt:'2027-01-05T12:00:00Z',force:true,expectedOrigins:new Set(['BER'])});
  assert.equal(result.rebuilt,true);assert.equal(result.poolRows,10);assert.deepEqual(db.writes[0].args.p_pool.map(r=>r.rank),[1,2,3,4,5,6,7,8,9,10]);
  assert.equal(db.writes[0].args.p_force,false);
});

test('daily owner reports the immutable same-day SQL no-op',async()=>{
  const db=selectionDb({published:false});const result=await publishSnapshot({db,snapshotAt:'2027-01-05T22:00:00Z',force:true,expectedOrigins:['BER']});
  assert.deepEqual(result,{rebuilt:false,observedOn:'2027-01-05',snapshotAt:null,reason:'already_published'});
});

test('manual origin recovery requires TP_TOKEN before provider construction or any publication RPC',async()=>{
  const db=selectionDb();let constructed=false;
  await assert.rejects(()=>manualRecoveryMain({env:{},db,snapshotAt:'2027-01-05T12:00:00Z',force:true,expectedOrigins:new Set(['BER']),
    providerFactory:()=>{constructed=true;throw new Error('must not construct');}}),/requires TP_TOKEN/);
  assert.equal(constructed,false);assert.equal(db.writes.length,0);
  const workflow=readFileSync(new URL('../.github/workflows/nightly-cheapest-selection.yml',import.meta.url),'utf8');
  assert.match(workflow,/Select the daily cheapest pool[\s\S]*TP_TOKEN: \$\{\{ secrets\.TP_TOKEN \}\}[\s\S]*snapshot-daily-origin-cheapest\.mjs/,
    'the earlier origin publication step must receive TP_TOKEN, not only the later window step');
});

test('actual manual origin path attempts selected tickets and fails closed before publication when the sweep is incomplete',async()=>{
  const db=selectionDb();let now=1000,requests=0;
  await assert.rejects(()=>manualRecoveryMain({env:{TP_TOKEN:'test-token'},db,snapshotAt:'2027-01-05T12:00:00Z',force:true,
    expectedOrigins:new Set(['BER']),clock:()=>now,providerFactory:()=>({request:async()=>{requests++;now=700000;return{kind:'refused',refusal:'server'};}})}),
    /refused incomplete point refresh \(1\/10\)/);
  assert.equal(requests,1);assert.equal(db.writes.length,0,'incomplete selected-ticket attempts must not reach publish_daily_cheapest_selection');
});

test('JavaScript publication guard rejects fewer than ten, duplicate cities, rank gaps and non-positive prices',()=>{
  const base=offers.map((row,index)=>({...row,rank:index+1}));
  const invalid=[base.slice(0,9),base.map((r,i)=>({...r,dest:i===9?'AMS':r.dest})),base.map((r,i)=>({...r,rank:i===9?9:r.rank})),base.map((r,i)=>({...r,price:i?r.price:0}))];
  for(const rows of invalid)assert.throws(()=>assertCompleteDailyRoulettePool(rows,new Set(['BER'])),/exactly 10|duplicate|rank gaps|non-positive/);
});

function harness(tickets,response,{latest='2027-01-05T06:00:00Z',lease=async()=>true}={}){
  const calls=[],tables=[];let requests=0;
  const db={rpc:(name,args)=>{calls.push({name,args});return settle({data:true,error:null})},from(table){tables.push(table);
    const result={data:table==='daily_origin_cheapest_pool'?[{snapshot_at:latest}]:[],error:null};let chain;
    chain=new Proxy({}, {get:(_,key)=>key==='then'?Promise.resolve(result).then.bind(Promise.resolve(result)):()=>chain});return chain},
    storage:{from:()=>({list:async()=>({data:[],error:null}),remove:async()=>({data:{},error:null})})}};
  const store={args:()=>({p_owner:'o',p_token:1}),lease,runId:'1',plan:async()=>({tickets,snapshotAt:latest})};
  const provider={request:async url=>{requests++;return response(requests,url)}};
  return{adapter:createAdapters({db,store,provider,clock:()=>1_700_000_000_000}).priority,calls,tables,get requests(){return requests}};
}
const ticket=(dest,rank)=>({observed_on:'2027-01-05',snapshot_at:'2027-01-05T06:00:00Z',origin:'BER',dest,flight_type:'any',
  departure_at:'2027-03-10',return_at:'2027-03-17',rank,price:100+rank,transfers:1,market:'de'});
const cp=(cursor=0)=>({cycle:1,dueAt:0,phase:'roulette',auditDone:true,roulette:{cycle:1,cursor,done:false,errors:0,snapshotAt:'2027-01-05T06:00:00Z'}});
const found=(_n,url)=>({kind:'ok',json:{success:true,data:[{origin:'BER',destination:new URL(url).searchParams.get('destination'),
  departure_at:'2027-03-10T06:00:00Z',return_at:'2027-03-17T20:00:00Z',price:77,transfers:1,airline:'XX'}]}});
const empty=()=>({kind:'ok',json:{success:true,data:[]}});

test('adapter performs one request per fixed slot and never reads replacements or alternative offers',async()=>{
  const h=harness([ticket('AMS',1),ticket('ATH',2)],found);let state=cp();
  for(let i=0;i<2;i++){state.phase='roulette';state=(await h.adapter.step({job:{id:1,planDate:'2027-01-05',checkpoint:state},deadline:1_700_000_200_000})).checkpoint;}
  assert.equal(h.requests,2);assert.equal(h.calls.filter(c=>c.name==='collection_commit_roulette').length,2);
  assert.ok(!h.tables.includes('offers'));assert.ok(!h.tables.includes('roulette_pool_replacements'));
});

test('adapter sends confirmed empty as a retention no-op and consumes no alternative-city request',async()=>{
  const h=harness([ticket('AMS',1)],empty);const result=await h.adapter.step({job:{id:1,planDate:'2027-01-05',checkpoint:cp()},deadline:1_700_000_200_000});
  assert.equal(h.requests,1);assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'collection_commit_roulette');
  assert.equal(h.calls[0].args.p_result.status,'no_result');assert.equal(result.checkpoint.roulette.cursor,1);
});

test('adapter records technical failure without any database mutation',async()=>{
  const h=harness([ticket('AMS',1)],()=>({kind:'timeout'}));const result=await h.adapter.step({job:{id:1,planDate:'2027-01-05',checkpoint:cp()},deadline:1_700_000_200_000});
  assert.equal(h.requests,1);assert.equal(h.calls.length,0);assert.equal(result.checkpoint.roulette.cursor,1);
  assert.equal(result.checkpoint.roulette.technicalDeferred[0].stage,'ticket');
});

test('manual refresh remains bounded, updates exact offer+pool on found, and contains no fare delete path',()=>{
  const source=readFileSync(new URL('./refresh-roulette-prices.mjs',import.meta.url),'utf8');
  assert.equal(MAX_REFRESH_TICKETS,220);assert.equal(capRefreshTickets(Array.from({length:221},(_,i)=>i)).length,220);
  assert.match(source,/from\('offers'\)\.update\(patch\)/);assert.match(source,/from\('daily_origin_cheapest_pool'\)\.update\(poolPatch\)/);
  assert.doesNotMatch(source,/from\('offers'\)\.delete\(/);assert.doesNotMatch(source,/from\('daily_origin_cheapest_pool'\)\.delete\(/);
  assert.match(source,/roulette_price_refresh_checkpoint/);
});

test('coordinated source contains no replacement machinery or alternative-city pool query',()=>{
  const source=readFileSync(new URL('./collection-adapters.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/roulette_pool_replacements|buildRouletteReplacementCandidates|pendingReplacement|allowed_dests/);
  const roulette=source.slice(source.indexOf("if(cp.phase==='roulette')"),source.indexOf("if(cp.phase==='weekend')"));
  assert.doesNotMatch(roulette,/load\('offers'/);
});
