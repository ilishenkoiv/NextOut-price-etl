import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { publishLegacyWindowCandidatesByOrigin } from './snapshot-daily-window-candidates.mjs';
import { runDueDailySelection } from './run-collection.mjs';
import { selectDailyCheapestPool, completeDailyRoulettePoolsByOrigin } from './snapshot-daily-origin-cheapest.mjs';
import { PGlite } from '@electric-sql/pglite';

const day='2026-11-02',snapshot='2026-11-02T06:30:00.000Z';
const row=(origin='MUC')=>({observed_on:day,snapshot_at:snapshot,origin,market:'de',flight_type:'any',region_codes:[],window_kind:'weekend',
  departure_at:'2026-11-20',return_at:'2026-11-23',position:1,dest:origin==='MUC'?'FCO':'MAD',destination_id:`fixture:${origin}`,
  exact_price:123,currency:'EUR',transfers:1,airline:null,exact_observed_at:snapshot,refresh_status:'fresh',refresh_checked_at:snapshot,last_error_kind:null,price_source:{table:'window_prices'} });

function legacyWindowClient(rows,outcomes={}){
  const calls=[];
  const query={eq(){return this;},order(){return this;},range:async()=>({data:rows,error:null})};
  return {calls,from:()=>({select:()=>query}),rpc:async(name,args)=>{
    calls.push({name,args});const outcome=outcomes[args.p_origin]??{data:true,error:null};return outcome;
  }};
}

test('legacy global completion with no MUC marker publishes factual MUC Local-break rows without provider work',async()=>{
  const client=legacyWindowClient([row('MUC')]);
  const result=await publishLegacyWindowCandidatesByOrigin(client,day);
  assert.deepEqual(result.publishedOrigins,['MUC']);
  assert.equal(client.calls.length,1);
  assert.equal(client.calls[0].name,'publish_daily_origin_window_candidates');
  assert.equal(client.calls[0].args.p_origin,'MUC');
  assert.equal(client.calls[0].args.p_candidates[0].snapshot_at,snapshot);
});

test('an FRA publication error cannot roll back the independently committed MUC marker',async()=>{
  const client=legacyWindowClient([row('MUC'),row('FRA')],{FRA:{data:null,error:new Error('FRA unavailable')}});
  const result=await publishLegacyWindowCandidatesByOrigin(client,day);
  assert.deepEqual(result.publishedOrigins,['MUC']);
  assert.deepEqual(result.failedOrigins,[{origin:'FRA',reason:'FRA unavailable'}]);
  assert.equal(client.calls.filter(call=>call.args.p_origin==='MUC').length,1);
});

test('a completed MUC marker is left alone idempotently',async()=>{
  const client=legacyWindowClient([row('MUC')],{MUC:{data:false,error:null}});
  const result=await publishLegacyWindowCandidatesByOrigin(client,day);
  assert.deepEqual(result.publishedOrigins,[]);
  assert.deepEqual(result.alreadyPublishedOrigins,['MUC']);
  assert.equal(client.calls.length,1,'only the RPC performs the marker idempotency check');
});

test('a legacy-complete coordinator checkpoint runs data-only catch-up and records truthful MUC roulette unavailability',async()=>{
  const instant=Date.parse('2026-11-02T06:30:00Z');
  const state={version:1,jobs:{priority:{id:1,done:true}},dailySelection:{day,windowDone:true,rouletteDone:true}};
  const saved=[],calls=[];const store={lease:async()=>true,save:async value=>saved.push(structuredClone(value))};
  const result=await runDueDailySelection({state,store,db:{},instant,
    publishWindows:async options=>{calls.push(['window',options]);return{published:true,publishedOrigins:['MUC']};},
    publishRoulette:async options=>{calls.push(['roulette',options]);return{rebuilt:false,reason:'no_complete_origins',incompleteOrigins:[{origin:'MUC',availableCities:0}]};}});
  assert.equal(result.published,true);
  assert.deepEqual(calls.map(([kind])=>kind),['window','roulette']);
  for(const [,options] of calls){assert.equal(options.catchUpOnly,true);assert.equal(options.provider,null,'catch-up never point-refreshes or calls the provider');}
  assert.equal(state.dailySelection.perOriginCatchupDone,true);
  assert.equal(state.dailySelection.perOriginCatchup.roulette.reason,'no_complete_origins');
  assert.ok(saved.some(entry=>entry.dailySelection?.perOriginCatchup?.window?.publishedOrigins?.includes('MUC')));
});

test('roulette catch-up changes the legacy global-marker guard without admitting an old ticket',()=>{
  const migration=readFileSync(new URL('../migrations/20261102143000_per_origin_same_day_catchup.sql',import.meta.url),'utf8');
  assert.match(migration,/Do not consult daily_cheapest_selection_runs here/);
  assert.match(migration,/invalid pre-existing daily selection without per-origin marker/);
  assert.match(migration,/insert into public\.daily_origin_cheapest_pool select \* from jsonb_populate_recordset/);
  assert.doesNotMatch(migration,/p_observed_on-1|October/i,'catch-up has no historical-pool fallback');
});

async function rouletteHarness(){
  const db=new PGlite();
  await db.exec(`
    create role service_role; create role anon; create role authenticated;
    create table public.daily_cheapest_origin_selection_runs(observed_on date,origin text,snapshot_at timestamptz,primary key(observed_on,origin));
    create table public.daily_origin_cheapest(
      observed_on date,snapshot_at timestamptz,created_at timestamptz,origin text,market text,flight_type text,dest text,destination_id text,
      price numeric,currency text,departure_at date,return_at date,transfers smallint,source_updated_at timestamptz,price_source jsonb);
    create table public.daily_origin_cheapest_pool(
      observed_on date,snapshot_at timestamptz,created_at timestamptz,origin text,market text,flight_type text,rank smallint,dest text,
      destination_id text,price numeric,currency text,departure_at date,return_at date,transfers smallint,source_updated_at timestamptz,price_source jsonb);
  `);
  await db.exec(readFileSync(new URL('../migrations/20261102143000_per_origin_same_day_catchup.sql',import.meta.url),'utf8'));
  return db;
}

const cities=['AMS','ATH','BCN','FCO','IST','LIS','PMI','PRG','VIE','ZRH'];
async function legacyRoulette(db,{kind='valid'}={}){
  const pool=cities.map((dest,index)=>[day,snapshot,'MUC','any',index+1,dest,100+index]);
  if(kind==='duplicate_dest')pool[9][5]='AMS';
  if(kind==='rank_gap')pool[9][4]=9;
  if(kind==='non_positive')pool[0][6]=0;
  if(kind==='snapshot_mismatch')pool[0][1]='2026-11-02T06:00:01Z';
  for(const values of pool)await db.query(`insert into public.daily_origin_cheapest_pool(observed_on,snapshot_at,origin,flight_type,rank,dest,price)
    values($1::date,$2::timestamptz,$3,$4,$5,$6,$7)`,values);
  if(kind!=='missing_rank1')await db.query(`insert into public.daily_origin_cheapest(observed_on,snapshot_at,origin,flight_type,dest,price)
    values($1::date,$2::timestamptz,'MUC','any','AMS',100)`,[day,snapshot]);
}
async function adoptLegacyRoulette(db){
  const pool=cities.map((dest,index)=>({observed_on:day,snapshot_at:snapshot,origin:'MUC',flight_type:'any',rank:index+1,dest,price:100+index}));
  const rank1=[{observed_on:day,snapshot_at:snapshot,origin:'MUC',flight_type:'any',dest:'AMS',price:100}];
  return db.query(`select public.publish_daily_cheapest_origin_selection($1::date,$2::timestamptz,'MUC',$3::jsonb,$4::jsonb) published`,
    [day,snapshot,JSON.stringify(rank1),JSON.stringify(pool)]);
}

test('PGlite: a valid current same-day legacy roulette payload is adopted without replacing its rows',async()=>{
  const db=await rouletteHarness();
  try{
    await legacyRoulette(db);
    const beforePool=await db.query(`select observed_on,snapshot_at,origin,flight_type,rank,dest,price from public.daily_origin_cheapest_pool order by rank`);
    const beforeRank1=await db.query(`select observed_on,snapshot_at,origin,flight_type,dest,price from public.daily_origin_cheapest order by dest`);

    const result=await adoptLegacyRoulette(db);
    assert.equal(result.rows[0].published,true,'the existing valid payload is adopted');
    assert.equal((await db.query(`select count(*)::integer n from public.daily_cheapest_origin_selection_runs where observed_on=$1::date and origin='MUC'`,[day])).rows[0].n,1,
      'adoption commits exactly one per-origin marker');
    assert.deepEqual((await db.query(`select observed_on,snapshot_at,origin,flight_type,rank,dest,price from public.daily_origin_cheapest_pool order by rank`)).rows,beforePool.rows,
      'adoption leaves the pre-existing ten-row pool unchanged');
    assert.deepEqual((await db.query(`select observed_on,snapshot_at,origin,flight_type,dest,price from public.daily_origin_cheapest order by dest`)).rows,beforeRank1.rows,
      'adoption leaves the compatible positive rank-1 row unchanged');
  }finally{await db.close();}
});

test('PGlite: malformed legacy roulette payloads are rejected and their new marker rolls back',async()=>{
  for(const kind of ['duplicate_dest','rank_gap','non_positive','snapshot_mismatch','missing_rank1']){
    const db=await rouletteHarness();
    try{
      await legacyRoulette(db,{kind});
      await assert.rejects(()=>adoptLegacyRoulette(db),/invalid pre-existing daily selection/);
      assert.equal((await db.query(`select count(*)::integer n from public.daily_cheapest_origin_selection_runs where observed_on=$1::date and origin='MUC'`,[day])).rows[0].n,0,
        `${kind}: failed adoption rolls back its marker`);
    }finally{await db.close();}
  }
});

test('same catch-up pass keeps MUC roulette published when FRA RPC fails, without a global barrier',async()=>{
  const previous=process.env.SUPABASE_SERVICE_KEY;process.env.SUPABASE_SERVICE_KEY='test-service-key';
  try{
    const {main}=await import(`./snapshot-daily-origin-cheapest.mjs?same-catchup-pass=${Date.now()}`);
    const instant=Date.parse(snapshot),offers=['MUC','FRA'].flatMap(origin=>cities.map((dest,index)=>({origin,market:'de',dest,
      flight_type:'any',price:100+index,departure_at:'2026-11-20',return_at:'2026-11-23',transfers:0,updated_at:snapshot,price_source:{}})));
    const published=new Set(),calls=[];
    const query={select(){return this;},gte(){return this;},gt(){return this;},order(){return this;},range:async()=>({data:offers,error:null})};
    const db={from:table=>{assert.equal(table,'offers');return query;},rpc:async(name,args)=>{
      calls.push(args.p_origin);if(args.p_origin==='FRA')return{data:null,error:new Error('FRA unavailable')};published.add(args.p_origin);return{data:true,error:null};}};
    const result=await main({db,snapshotAt:snapshot,clock:()=>instant,expectedOrigins:new Set(['MUC','FRA']),catchUpOnly:true,provider:null});
    assert.deepEqual(result.publishedOrigins,['MUC']);
    assert.deepEqual(result.failedOrigins,[{origin:'FRA',reason:'FRA unavailable'}]);
    assert.deepEqual(calls,['MUC','FRA'],'FRA is attempted after committed MUC, not behind a global barrier');
    assert.deepEqual([...published],['MUC'],'FRA failure does not roll back MUC');
  }finally{if(previous===undefined)delete process.env.SUPABASE_SERVICE_KEY;else process.env.SUPABASE_SERVICE_KEY=previous;}
});

test('MUC roulette is truthfully unavailable when current validated offers lack ten cities; an old pool is not an input',()=>{
  const currentPool=selectDailyCheapestPool([],day,10);
  const result=completeDailyRoulettePoolsByOrigin(currentPool,new Set(['MUC']));
  assert.equal(result.complete.size,0);
  assert.deepEqual(result.incomplete,[{origin:'MUC',reason:'Daily roulette publication requires exactly 10 real cities for MUC (0/10)',availableCities:0}]);
  const source=readFileSync(new URL('./snapshot-daily-origin-cheapest.mjs',import.meta.url),'utf8');
  const catchupSection=source.slice(source.indexOf('catchUpOnly=false'),source.indexOf('let publishedOrigins'));
  assert.match(catchupSection,/from\('offers'\)/);
  assert.doesNotMatch(catchupSection,/daily_origin_cheapest_pool/,'historical roulette rows cannot become a fake current ticket');
});
