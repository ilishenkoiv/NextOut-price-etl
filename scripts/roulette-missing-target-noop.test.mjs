import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const immutable=readFileSync(new URL('../migrations/20260928120000_immutable_daily_roulette_membership.sql',import.meta.url),'utf8');
const fix=readFileSync(new URL('../migrations/20260928160000_roulette_missing_target_noop.sql',import.meta.url),'utf8');

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
    create table public.roulette_pool_replacements(event_key text primary key,payload jsonb);
  `);
  await db.exec(immutable);await db.exec(fix);
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
async function publish(db,rows){await db.query('select public.publish_daily_cheapest_selection($1,$2,$3::jsonb,$4::jsonb,false)',
  [rows[0].observed_on,rows[0].snapshot_at,JSON.stringify(rank1(rows)),JSON.stringify(rows)]);}
async function commit(db,owner,ticket,result,token=7){return db.query('select public.collection_commit_roulette($1,$2,$3::jsonb,$4::jsonb) ok',
  [owner,token,JSON.stringify(ticket),JSON.stringify(result)]);}
async function snapshot(db){
  const row=(await db.query(`select jsonb_build_object(
    'offers',coalesce((select jsonb_agg(to_jsonb(o) order by origin,dest,departure_at) from public.offers o),'[]'::jsonb),
    'current',coalesce((select jsonb_agg(to_jsonb(c) order by snapshot_at,origin) from public.daily_origin_cheapest c),'[]'::jsonb),
    'history',coalesce((select jsonb_agg(to_jsonb(p) order by snapshot_at,origin,rank) from public.daily_origin_cheapest_pool p),'[]'::jsonb),
    'epochs',coalesce((select jsonb_agg(to_jsonb(e) order by observed_on) from public.daily_cheapest_selection_runs e),'[]'::jsonb),
    'audit',coalesce((select jsonb_agg(to_jsonb(a) order by event_key) from public.roulette_pool_replacements a),'[]'::jsonb)) value`)).rows[0].value;
  return JSON.stringify(row);
}
async function seedTwoDays(db){const historical=pool('2098-12-31','2098-12-31T06:00:00Z'),current=pool();await publish(db,historical);await publish(db,current);return{historical,current};}
async function seedOffer(db,ticket){await db.query(`insert into public.offers(origin,market,dest,month,flight_type,departure_at,return_at,nights,price,transfers,airline,updated_at,price_source)
  values($1,'de',$2,'2099-03','any','2099-03-01','2099-03-08',7,100,1,'XX','2099-01-01T06:00:00Z','{"table":"offers"}')`,[ticket.origin,ticket.dest]);}

test('PGlite: absent exact target accepts every result type and changes no persisted byte',async()=>{
  const{db,owner}=await harness();try{
    const{current}=await seedTwoDays(db);const ticket=current[1];await seedOffer(db,ticket);
    await db.query('delete from public.daily_origin_cheapest_pool where snapshot_at=$1 and origin=$2 and flight_type=$3 and rank=$4',
      [ticket.snapshot_at,ticket.origin,ticket.flight_type,ticket.rank]);
    const before=await snapshot(db);
    const results=[
      {status:'found',price:77,transfers:1,airline:'YY',updated_at:'2099-01-01T07:00:00Z',price_source:{table:'offers',run_id:'found'}},
      {status:'no_result'},
      {status:'technical',detail:'timeout_or_429'},
      {},
      {status:'no_result',replacement:{origin:'BER',dest:'XXX',price:1}}
    ];
    for(const result of results){
      assert.equal((await commit(db,owner,ticket,result)).rows[0].ok,true);
      assert.equal(await snapshot(db),before);
    }
  }finally{await db.close();}
});

test('PGlite: existing target retains price and membership for every non-found payload',async()=>{
  const{db,owner}=await harness();try{
    const{current}=await seedTwoDays(db);const ticket=current[0];await seedOffer(db,ticket);const before=await snapshot(db);
    for(const result of [{status:'no_result'},{status:'technical',detail:'timeout_or_429'},{},
      {status:'no_result',replacement:{origin:'BER',dest:'XXX',price:1}}]){
      assert.equal((await commit(db,owner,ticket,result)).rows[0].ok,true);
      assert.equal(await snapshot(db),before);
    }
  }finally{await db.close();}
});

test('PGlite: lease loss and malformed tickets still fail before missing-target no-op',async()=>{
  const{db,owner}=await harness();try{
    const valid=pool()[0];
    await assert.rejects(()=>commit(db,'00000000-0000-0000-0000-000000000099',valid,{status:'no_result'}),/collection lease lost/);
    await assert.rejects(()=>commit(db,owner,{snapshot_at:valid.snapshot_at,origin:'BER'},{status:'no_result'}),/invalid roulette ticket/);
  }finally{await db.close();}
});

test('PGlite: existing found target changes only permitted exact price/provenance/time fields',async()=>{
  const{db,owner}=await harness();try{
    const{current}=await seedTwoDays(db);const ticket=current[0];await seedOffer(db,ticket);
    const beforePool=(await db.query('select to_jsonb(p) value from public.daily_origin_cheapest_pool p where snapshot_at=$1 and rank=1',[ticket.snapshot_at])).rows[0].value;
    const beforeCurrent=(await db.query('select to_jsonb(c) value from public.daily_origin_cheapest c where snapshot_at=$1',[ticket.snapshot_at])).rows[0].value;
    const beforeOffer=(await db.query('select to_jsonb(o) value from public.offers o')).rows[0].value;
    const result={status:'found',price:77,transfers:2,airline:'YY',updated_at:'2099-01-01T07:00:00Z',price_source:{table:'offers',run_id:'7'}};
    assert.equal((await commit(db,owner,ticket,result)).rows[0].ok,true);
    const afterPool=(await db.query('select to_jsonb(p) value from public.daily_origin_cheapest_pool p where snapshot_at=$1 and rank=1',[ticket.snapshot_at])).rows[0].value;
    const afterCurrent=(await db.query('select to_jsonb(c) value from public.daily_origin_cheapest c where snapshot_at=$1',[ticket.snapshot_at])).rows[0].value;
    const afterOffer=(await db.query('select to_jsonb(o) value from public.offers o')).rows[0].value;
    const unchanged=(before,after,allowed)=>Object.fromEntries(Object.entries(after).filter(([key])=>!allowed.includes(key)));
    assert.deepEqual(unchanged(beforePool,afterPool,['price','transfers','source_updated_at','price_source','market']),unchanged(afterPool,beforePool,['price','transfers','source_updated_at','price_source','market']));
    assert.deepEqual(unchanged(beforeCurrent,afterCurrent,['price','transfers','source_updated_at','price_source','market']),unchanged(afterCurrent,beforeCurrent,['price','transfers','source_updated_at','price_source','market']));
    assert.deepEqual(unchanged(beforeOffer,afterOffer,['price','transfers','airline','updated_at','price_source','market']),unchanged(afterOffer,beforeOffer,['price','transfers','airline','updated_at','price_source','market']));
    assert.equal(Number(afterPool.price),77);assert.equal(Number(afterCurrent.price),77);assert.equal(Number(afterOffer.price),77);
    assert.equal(JSON.parse(await snapshot(db)).history.filter(row=>row.snapshot_at.startsWith('2098-12-31'))[0].price,100);
  }finally{await db.close();}
});

test('PGlite: locked exact-slot update mismatch fails closed and rolls back offer mutation',async()=>{
  const{db,owner}=await harness();try{
    const{current}=await seedTwoDays(db);const ticket=current[0];await seedOffer(db,ticket);const before=await snapshot(db);
    await db.exec(`create function suppress_pool_update() returns trigger language plpgsql as $$begin return null;end$$;
      create trigger suppress_pool_update before update on public.daily_origin_cheapest_pool for each row execute function suppress_pool_update();`);
    await assert.rejects(()=>commit(db,owner,ticket,{status:'found',price:77,transfers:1,updated_at:'2099-01-01T07:00:00Z',price_source:{table:'offers'}}),/roulette target changed before confirmed-price sync/);
    assert.equal(await snapshot(db),before);
  }finally{await db.close();}
});

test('contract: fix-forward is non-destructive and operational SQL is present',()=>{
  assert.match(fix,/if not found then return true/);
  assert.match(fix,/if \(p_result->>'status'\) is distinct from 'found' then return true/);
  assert.match(fix,/pool_updated<>1 then raise exception 'roulette target changed before confirmed-price sync'/);
  assert.doesNotMatch(fix,/delete from|insert into public\.(?:offers|daily_origin_cheapest|daily_origin_cheapest_pool|roulette_pool_replacements)/i);
  const readback=readFileSync(new URL('./readback-roulette-missing-target-noop.sql',import.meta.url),'utf8');
  const rollback=readFileSync(new URL('./rollback-roulette-missing-target-noop.sql',import.meta.url),'utf8');
  assert.match(readback,/pg_get_functiondef/);assert.match(readback,/missing_target_is_noop/);
  assert.match(rollback,/rollback blocked/);assert.match(rollback,/20260928120000_immutable_daily_roulette_membership/);
});
