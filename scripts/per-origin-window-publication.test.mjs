import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration=readFileSync(new URL('../migrations/20261102123000_per_origin_window_publication.sql',import.meta.url),'utf8');

function candidate({day='2099-01-01',snapshot='2099-01-01T03:30:00Z',origin='MUC',dest='QWA',departure='2099-01-15',position=1}={}){
  return {contract_version:1,observed_on:day,snapshot_at:snapshot,origin,market:'de',flight_type:'any',region_codes:[],window_kind:'weekend',
    departure_at:departure,return_at:'2099-01-18',position,dest,destination_id:`fixture:${dest.toLowerCase()}`,
    exact_price:100,currency:'EUR',transfers:1,airline:null,exact_observed_at:snapshot,refresh_status:'fresh',
    refresh_checked_at:snapshot,last_error_kind:null,price_source:{table:'window_prices'}};
}

async function harness(){
  const db=new PGlite();
  await db.exec(`
    create role service_role; create role anon; create role authenticated;
    create function public.aviasales_market_for_origin(text) returns text language sql immutable as $$select 'de'::text$$;
    create table public.daily_window_candidate_epochs(observed_on date primary key,snapshot_at timestamptz not null unique,contract_version smallint not null,candidate_rows integer not null,exact_request_groups integer not null);
    create table public.daily_window_candidates(observed_on date not null,snapshot_at timestamptz not null,origin text not null,flight_type text not null,departure_at date not null,return_at date not null,position smallint not null,destination_id text not null);
  `);
  await db.exec(migration);
  return db;
}

async function publish(db,day,snapshot,origin,rows){
  return db.query('select public.publish_daily_origin_window_candidates($1::date,$2::timestamptz,$3::text,$4::jsonb) published',
    [day,snapshot,origin,JSON.stringify(rows)]);
}

test('MUC window publication succeeds while FRA is absent, is same-day idempotent, and leaves FRA untouched',async()=>{
  const db=await harness();
  try{
    await db.query(`insert into public.daily_window_candidate_epochs values('2099-01-01','2099-01-01T00:00:00Z',1,1,1)`);
    const day='2099-01-01',snapshot='2099-01-01T03:30:00Z';
    assert.equal((await publish(db,day,snapshot,'MUC',[candidate({day,snapshot})])).rows[0].published,true);
    assert.equal((await publish(db,day,'2099-01-01T04:00:00Z','MUC',[candidate({day,snapshot:'2099-01-01T04:00:00Z'})])).rows[0].published,false,
      'the marker freezes MUC membership for the Berlin day');
    const rows=await db.query(`select origin,count(*)::integer n from public.daily_origin_window_candidates group by origin order by origin`);
    assert.deepEqual(rows.rows,[{origin:'MUC',n:1}]);
    const legacy=await db.query(`select snapshot_at from public.daily_window_candidate_epochs where observed_on='2099-01-01'`);
    assert.equal(new Date(legacy.rows[0].snapshot_at).toISOString(),'2099-01-01T00:00:00.000Z',
      'legacy global epoch is compatibility-only and unchanged');
  }finally{await db.close();}
});

test('fallback copies only yesterday’s identical MUC mode/date slot with stale provenance',async()=>{
  const db=await harness();
  try{
    const yesterday='2099-01-01',oldSnapshot='2099-01-01T03:30:00Z';
    await publish(db,yesterday,oldSnapshot,'MUC',[candidate({day:yesterday,snapshot:oldSnapshot,dest:'QWA'})]);
    await publish(db,yesterday,'2099-01-01T03:31:00Z','FRA',[candidate({day:yesterday,snapshot:'2099-01-01T03:31:00Z',origin:'FRA',dest:'QWB'})]);
    const today='2099-01-02',snapshot='2099-01-02T03:30:00Z';
    await publish(db,today,snapshot,'MUC',[candidate({day:today,snapshot,dest:'QWC',departure:'2099-01-16'})]);
    const rows=await db.query(`select origin,dest,departure_at::text,refresh_status,exact_observed_at::text,price_source->'carousel_fallback'->>'kind' fallback
      from public.daily_origin_window_candidates where observed_on='2099-01-02' order by departure_at,dest`);
    assert.deepEqual(rows.rows.map(row=>({...row,exact_observed_at:new Date(row.exact_observed_at).toISOString()})),[
      {origin:'MUC',dest:'QWA',departure_at:'2099-01-15',refresh_status:'failed',exact_observed_at:'2099-01-01T03:30:00.000Z',fallback:'previous_day_same_origin_mode_dates'},
      {origin:'MUC',dest:'QWC',departure_at:'2099-01-16',refresh_status:'fresh',exact_observed_at:'2099-01-02T03:30:00.000Z',fallback:null},
    ]);
  }finally{await db.close();}
});

test('migration retains the legacy global publisher and scopes all fallback matching to one origin',()=>{
  assert.match(migration,/daily_origin_window_candidate_runs[\s\S]*primary key\(observed_on,origin\)/);
  assert.match(migration,/publish_daily_origin_window_candidates/);
  assert.match(migration,/old\.observed_on=p_observed_on-1 and old\.origin=p_origin/);
  assert.match(migration,/current\.origin=p_origin[\s\S]*current\.flight_type=old\.flight_type[\s\S]*current\.departure_at=old\.departure_at[\s\S]*current\.return_at=old\.return_at/);
  assert.match(migration,/'previous_day_same_origin_mode_dates'/);
  assert.match(migration,/jsonb_typeof\(r->'price_source'\) is distinct from 'object'/);
  assert.doesNotMatch(migration,/create or replace function public\.publish_daily_window_candidates/);
});
