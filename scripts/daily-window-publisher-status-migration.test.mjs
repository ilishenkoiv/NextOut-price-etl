import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration=readFileSync(new URL('../migrations/20260927120000_publish_daily_window_candidate_statuses.sql',import.meta.url),'utf8');
const rollback=readFileSync(new URL('./rollback-publish-daily-window-candidate-statuses.sql',import.meta.url),'utf8');

async function harness(){
  const db=new PGlite();
  await db.exec(`
    create role service_role;
    create role anon;
    create role authenticated;
    create function public.aviasales_market_for_origin(text) returns text language sql immutable as $$select 'de'::text$$;
    create table public.daily_window_candidate_epochs(
      observed_on date primary key,snapshot_at timestamptz not null unique,contract_version smallint not null,
      candidate_rows integer not null,exact_request_groups integer not null,completed_at timestamptz default clock_timestamp());
    create table public.daily_window_candidates(
      observed_on date not null,snapshot_at timestamptz not null,origin text not null,market text not null,flight_type text not null,
      region_codes text[] not null,window_kind text not null,departure_at date not null,return_at date not null,position smallint not null,
      dest text not null,destination_id text not null,exact_price numeric(10,2),currency text not null,transfers smallint,airline text,
      exact_observed_at timestamptz,refresh_status text not null,refresh_checked_at timestamptz,last_error_kind text,price_source jsonb,
      primary key(snapshot_at,origin,flight_type,departure_at,return_at,position));
  `);
  return db;
}

function candidate({day='2099-01-01',snapshot='2099-01-01T03:30:00Z',status='fresh',position=1,dest='QWA'}={}){
  return {contract_version:1,observed_on:day,snapshot_at:snapshot,origin:'FRA',market:'de',flight_type:'any',region_codes:[],
    window_kind:'weekend',departure_at:'2099-01-15',return_at:'2099-01-18',position,dest,destination_id:`fixture:${dest.toLowerCase()}`,
    exact_price:100+position,currency:'EUR',transfers:1,airline:null,exact_observed_at:snapshot,refresh_status:status,
    refresh_checked_at:snapshot,last_error_kind:status==='failed'?'provider_error':null,price_source:{table:'window_prices'}};
}

async function publish(db,day,snapshot,candidates){
  return db.query('select public.publish_daily_window_candidates($1::date,$2::timestamptz,$3::jsonb) published',
    [day,snapshot,JSON.stringify(candidates)]);
}

test('publisher migration atomically accepts truthful fresh/unavailable/failed rows and keeps every other predicate',async()=>{
  const db=await harness();
  try{
    await db.exec(migration);
    const day='2099-01-01',snapshot='2099-01-01T03:30:00Z';
    const rows=[candidate(),candidate({status:'unavailable',position:2,dest:'QWB'}),candidate({status:'failed',position:3,dest:'QWC'})];
    const result=await publish(db,day,snapshot,rows);
    assert.equal(result.rows[0].published,true);
    const stored=await db.query('select refresh_status,count(*)::integer n from public.daily_window_candidates group by refresh_status order by refresh_status');
    assert.deepEqual(stored.rows,[{refresh_status:'failed',n:1},{refresh_status:'fresh',n:1},{refresh_status:'unavailable',n:1}]);
    const epoch=await db.query('select candidate_rows,exact_request_groups from public.daily_window_candidate_epochs where observed_on=$1',[day]);
    assert.deepEqual(epoch.rows,[{candidate_rows:3,exact_request_groups:3}]);

    const badDay='2099-01-02',badSnapshot='2099-01-02T03:30:00Z';
    const invalid=candidate({day:badDay,snapshot:badSnapshot,status:'unknown'});
    await assert.rejects(()=>publish(db,badDay,badSnapshot,[invalid]),/invalid daily window candidate row/);
    const badEpoch=await db.query('select count(*)::integer n from public.daily_window_candidate_epochs where observed_on=$1',[badDay]);
    assert.equal(badEpoch.rows[0].n,0,'invalid publication remains atomic');

    await db.exec(rollback);
    const rollbackDay='2099-01-03',rollbackSnapshot='2099-01-03T03:30:00Z';
    await assert.rejects(()=>publish(db,rollbackDay,rollbackSnapshot,[candidate({day:rollbackDay,snapshot:rollbackSnapshot,status:'unavailable'})]),
      /invalid daily window candidate row/);
  }finally{await db.close();}
});
