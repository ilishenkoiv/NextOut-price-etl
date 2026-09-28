import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const migration=readFileSync(new URL('../migrations/20260928120000_immutable_daily_roulette_membership.sql',import.meta.url),'utf8');
const windowMigration=readFileSync(new URL('../migrations/20260922140000_daily_window_candidates.sql',import.meta.url),'utf8');

async function harness(){
  const db=new PGlite();
  await db.exec(`
    create role service_role;create role anon;create role authenticated;
    create function public.aviasales_market_for_origin(text) returns text language sql immutable as $$select 'de'::text$$;
    create table public.collection_scheduler_state(singleton boolean primary key,owner uuid,fence bigint,lease_until timestamptz);
    create table public.daily_cheapest_selection_runs(observed_on date primary key,snapshot_at timestamptz not null unique,completed_at timestamptz default clock_timestamp());
    create table public.daily_origin_cheapest(
      observed_on date,snapshot_at timestamptz,created_at timestamptz,origin text,market text,flight_type text,dest text,destination_id text,
      price numeric,currency text,departure_at date,return_at date,transfers smallint,source_updated_at timestamptz,price_source jsonb);
    create table public.daily_origin_cheapest_pool(
      observed_on date,snapshot_at timestamptz,created_at timestamptz,origin text,market text,flight_type text,rank smallint,dest text,
      destination_id text,price numeric,currency text,departure_at date,return_at date,transfers smallint,source_updated_at timestamptz,
      price_source jsonb,primary key(snapshot_at,origin,flight_type,rank));
    create table public.offers(origin text,market text,dest text,month text,flight_type text,departure_at date,return_at date,nights smallint,
      price numeric,transfers smallint,airline text,updated_at timestamptz,price_source jsonb,
      primary key(origin,dest,month,flight_type,departure_at,return_at));
    create table public.roulette_pool_replacements(event_key text primary key);
  `);
  await db.exec(migration);
  const owner='00000000-0000-0000-0000-000000000001';
  await db.query("insert into public.collection_scheduler_state values(true,$1,7,clock_timestamp()+interval '1 hour')",[owner]);
  return{db,owner};
}

const cities=['AMS','ATH','BCN','FCO','IST','LIS','PMI','PRG','VIE','ZRH'];
function pool(day='2099-01-01',snapshot='2099-01-01T06:00:00Z'){
  return cities.map((dest,index)=>({observed_on:day,snapshot_at:snapshot,created_at:snapshot,origin:'BER',market:'de',flight_type:'any',
    rank:index+1,dest,destination_id:dest.toLowerCase(),price:100+index,currency:'EUR',departure_at:'2099-03-01',return_at:'2099-03-08',
    transfers:1,source_updated_at:snapshot,price_source:{table:'offers'}}));
}
function rank1(rows){const r=rows[0];return[{observed_on:r.observed_on,snapshot_at:r.snapshot_at,created_at:r.created_at,origin:r.origin,
  market:r.market,flight_type:r.flight_type,dest:r.dest,destination_id:r.destination_id,price:r.price,currency:r.currency,
  departure_at:r.departure_at,return_at:r.return_at,transfers:r.transfers,source_updated_at:r.source_updated_at,price_source:r.price_source}];}
async function publish(db,rows,force=false){return db.query('select public.publish_daily_cheapest_selection($1,$2,$3::jsonb,$4::jsonb,$5) ok',
  [rows[0].observed_on,rows[0].snapshot_at,JSON.stringify(rank1(rows)),JSON.stringify(rows),force]);}
async function commit(db,owner,ticket,result){return db.query('select public.collection_commit_roulette($1,7,$2::jsonb,$3::jsonb) ok',
  [owner,JSON.stringify(ticket),JSON.stringify(result)]);}
async function state(db){return (await db.query(`select jsonb_build_object(
  'pool',(select jsonb_agg(to_jsonb(p) order by snapshot_at,rank) from public.daily_origin_cheapest_pool p),
  'offers',(select jsonb_agg(to_jsonb(o) order by origin,dest) from public.offers o),
  'runs',(select jsonb_agg(to_jsonb(r) order by observed_on) from public.daily_cheapest_selection_runs r),
  'audit',(select count(*) from public.roulette_pool_replacements)) state`)).rows[0].state;}

test('PGlite: same-day force is immutable and invalid ten-city publications are rejected',async()=>{
  const{db}=await harness();try{
    const rows=pool();assert.equal((await publish(db,rows)).rows[0].ok,true);
    assert.equal((await publish(db,pool('2099-01-01','2099-01-01T12:00:00Z'),true)).rows[0].ok,false);
    const cases=[
      rows.slice(0,9).map(r=>({...r,observed_on:'2099-01-02',snapshot_at:'2099-01-02T06:00:00Z'})),
      rows.map((r,i)=>({...r,observed_on:'2099-01-03',snapshot_at:'2099-01-03T06:00:00Z',dest:i===9?'AMS':r.dest})),
      rows.map((r,i)=>({...r,observed_on:'2099-01-04',snapshot_at:'2099-01-04T06:00:00Z',rank:i===9?9:r.rank})),
      rows.map((r,i)=>({...r,observed_on:'2099-01-05',snapshot_at:'2099-01-05T06:00:00Z',price:i===0?0:r.price})),
    ];
    for(const invalid of cases)await assert.rejects(()=>publish(db,invalid),/daily roulette origin|invalid daily selection/);
  }finally{await db.close();}
});

test('PGlite: every non-found or legacy payload preserves current/history membership, ranks, offers and prices',async()=>{
  const{db,owner}=await harness();try{
    const old=pool('2098-12-31','2098-12-31T06:00:00Z'),current=pool();
    await publish(db,old);await publish(db,current);
    const ticket=current[0];await db.query(`insert into public.offers(origin,market,dest,month,flight_type,departure_at,return_at,nights,price,transfers,airline,updated_at,price_source)
      values($1,'de',$2,'2099-03','any','2099-03-01','2099-03-08',7,100,1,'XX','2099-01-01T06:00:00Z','{"table":"offers"}')`,[ticket.origin,ticket.dest]);
    const before=await state(db);
    for(const result of [{status:'no_result'},{status:'error',detail:'timeout'},{},{status:'no_result',replacement:{dest:'XXX',price:1}}]){
      assert.equal((await commit(db,owner,ticket,result)).rows[0].ok,true);
      assert.deepEqual(await state(db),before);
    }
  }finally{await db.close();}
});

test('PGlite: found changes only mutable price/provenance/time fields on the exact current slot',async()=>{
  const{db,owner}=await harness();try{
    const old=pool('2098-12-31','2098-12-31T06:00:00Z'),current=pool();await publish(db,old);await publish(db,current);
    const ticket=current[0];await db.query(`insert into public.offers(origin,market,dest,month,flight_type,departure_at,return_at,nights,price,transfers,airline,updated_at,price_source)
      values($1,'de',$2,'2099-03','any','2099-03-01','2099-03-08',7,100,1,'XX','2099-01-01T06:00:00Z','{"table":"offers"}')`,[ticket.origin,ticket.dest]);
    await commit(db,owner,ticket,{status:'found',price:77,transfers:2,airline:'YY',updated_at:'2099-01-01T07:00:00Z',price_source:{table:'offers',run_id:'7'}});
    const changed=(await db.query(`select observed_on::text,snapshot_at::text,origin,flight_type,rank,dest,departure_at::text,return_at::text,
      price::float8,transfers,source_updated_at::text,price_source from public.daily_origin_cheapest_pool
      where snapshot_at=$1 and rank=1`,[ticket.snapshot_at])).rows[0];
    assert.equal(Date.parse(changed.snapshot_at),Date.parse(ticket.snapshot_at));
    assert.deepEqual({...changed,snapshot_at:undefined,source_updated_at:undefined,price_source:undefined},{observed_on:'2099-01-01',snapshot_at:undefined,origin:'BER',flight_type:'any',rank:1,dest:'AMS',departure_at:'2099-03-01',return_at:'2099-03-08',price:77,transfers:2,source_updated_at:undefined,price_source:undefined});
    assert.equal((await db.query("select price::float8 from public.daily_origin_cheapest_pool where snapshot_at='2098-12-31T06:00:00Z' and rank=1")).rows[0].price,100);
    assert.equal((await db.query('select price::float8 from public.offers')).rows[0].price,77);
  }finally{await db.close();}
});

test('window empty/error updates status metadata without touching exact price or immutable identity',()=>{
  const noResult=/elsif status='no_result'[\s\S]*?update public\.daily_window_candidates set refresh_status='unavailable',refresh_checked_at=clock_timestamp\(\),last_error_kind=null[\s\S]*?elsif status='error'/.exec(windowMigration)?.[0]??'';
  const error=/elsif status='error'[\s\S]*?update public\.daily_window_candidates set refresh_status='failed',refresh_checked_at=clock_timestamp\(\),[\s\S]*?else/.exec(windowMigration)?.[0]??'';
  for(const branch of [noResult,error]){
    assert.ok(branch);assert.doesNotMatch(branch,/set\s+(?:exact_price|exact_observed_at|price_source|dest|destination_id|position|departure_at|return_at)\s*=/i);
  }
});
