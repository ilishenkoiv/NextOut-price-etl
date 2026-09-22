-- Production-safe controlled proof after 20260922130000 is applied. Schedules must stay paused.
-- All synthetic QAA/QBB/QCC rows and scheduler changes roll back with this transaction.
begin;
set local lock_timeout='10s';
do $$ declare test_owner uuid:='00000000-0000-4000-8000-000000000099'; f bigint; ok boolean;
  before_current integer; after_current integer;
begin
  select fence into f from public.collection_scheduler_state where singleton and owner is null and lease_until is null for update;
  if f is null then raise exception 'scheduler is not idle'; end if;
  update public.collection_scheduler_state set owner=test_owner,fence=f+1,run_id='replacement-sql-test',
    lease_until=clock_timestamp()+interval '10 minutes' where singleton;
  insert into public.offers(origin,market,dest,month,flight_type,departure_at,return_at,nights,price,transfers,updated_at,price_source)
    values('FRA','de','QAA','2099-01','any','2099-01-10','2099-01-17',7,999,1,clock_timestamp(),'{}'),
          ('FRA','de','QBB','2099-02','any','2099-02-10','2099-02-17',7,123,0,clock_timestamp(),'{}'),
          ('FRA','de','QCC','2099-03','any','2099-03-10','2099-03-17',7,555,1,clock_timestamp(),'{}');
  insert into public.daily_origin_cheapest_pool(observed_on,snapshot_at,origin,market,flight_type,rank,dest,price,currency,
    departure_at,return_at,transfers,source_updated_at,price_source)
    values('2099-01-01','2099-01-01T03:30:00Z','FRA','de','any',1,'QAA',999,'EUR','2099-01-10','2099-01-17',1,clock_timestamp(),'{}'),
          ('2099-01-01','2099-01-01T03:30:00Z','FRA','de','any',2,'QCC',555,'EUR','2099-03-10','2099-03-17',1,clock_timestamp(),'{}'),
          ('2098-12-31','2098-12-31T03:30:00Z','FRA','de','any',3,'QAA',999,'EUR','2099-01-10','2099-01-17',1,clock_timestamp(),'{}');
  select count(*) into before_current from public.daily_origin_cheapest_pool
    where snapshot_at='2099-01-01T03:30:00Z' and origin='FRA' and flight_type='any';
  ok:=public.collection_commit_roulette(test_owner,f+1,
    jsonb_build_object('observed_on','2099-01-01','snapshot_at','2099-01-01T03:30:00Z','origin','FRA','market','de',
      'flight_type','any','rank',1,'dest','QAA','price',999,'currency','EUR','departure_at','2099-01-10',
      'return_at','2099-01-17','transfers',1,'allowed_dests',jsonb_build_array('QAA','QBB'),'run_id','replacement-sql-test'),
    jsonb_build_object('status','no_result','replacement',jsonb_build_object('origin','FRA','market','de','dest','QBB',
      'month','2099-02','flight_type','any','departure_at','2099-02-10','return_at','2099-02-17','nights',7,
      'price',123,'transfers',0,'updated_at',clock_timestamp(),'price_source','{}'::jsonb)));
  select count(*) into after_current from public.daily_origin_cheapest_pool
    where snapshot_at='2099-01-01T03:30:00Z' and origin='FRA' and flight_type='any';
  if not ok or exists(select 1 from public.daily_origin_cheapest_pool where snapshot_at='2099-01-01T03:30:00Z' and rank=1 and dest='QAA')
    or not exists(select 1 from public.daily_origin_cheapest_pool where snapshot_at='2099-01-01T03:30:00Z' and rank=1 and dest='QBB')
    or exists(select 1 from public.daily_origin_cheapest_pool where snapshot_at='2098-12-31T03:30:00Z' and dest='QAA')
    or before_current<>after_current
    or not exists(select 1 from public.daily_origin_cheapest_pool where snapshot_at='2099-01-01T03:30:00Z' and rank=2 and dest='QCC')
    or exists(select 1 from public.offers where origin='FRA' and dest='QAA' and departure_at='2099-01-10')
    or not exists(select 1 from public.offers where origin='FRA' and dest='QBB' and departure_at='2099-02-10')
    or not exists(select 1 from public.roulette_pool_replacements where snapshot_at='2099-01-01T03:30:00Z' and rank=1
      and outcome='replaced' and historical_rows_removed=2)
    then raise exception 'targeted replacement assertion failed'; end if;
  -- Exact retry must be idempotent: no second audit row and no membership/rank change.
  ok:=public.collection_commit_roulette(test_owner,f+1,
    jsonb_build_object('observed_on','2099-01-01','snapshot_at','2099-01-01T03:30:00Z','origin','FRA','market','de',
      'flight_type','any','rank',1,'dest','QAA','departure_at','2099-01-10','return_at','2099-01-17',
      'allowed_dests',jsonb_build_array('QAA','QBB'),'run_id','replacement-sql-test'),
    jsonb_build_object('status','no_result','replacement',jsonb_build_object('origin','FRA','market','de','dest','QBB',
      'month','2099-02','flight_type','any','departure_at','2099-02-10','return_at','2099-02-17','nights',7,
      'price',123,'transfers',0,'updated_at',clock_timestamp(),'price_source','{}'::jsonb)));
  if not ok or (select count(*) from public.roulette_pool_replacements where snapshot_at='2099-01-01T03:30:00Z' and rank=1)<>1
    or not exists(select 1 from public.daily_origin_cheapest_pool where snapshot_at='2099-01-01T03:30:00Z' and rank=1 and dest='QBB')
    then raise exception 'targeted replacement idempotency assertion failed'; end if;
  perform public.collection_commit_roulette(test_owner,f+1,
    jsonb_build_object('observed_on','2099-01-01','snapshot_at','2099-01-01T03:30:00Z','origin','FRA','market','de',
      'flight_type','any','rank',2,'dest','QCC','price',555,'currency','EUR','departure_at','2099-03-10',
      'return_at','2099-03-17','transfers',1,'allowed_dests',jsonb_build_array('QCC'),'run_id','replacement-sql-test'),
    jsonb_build_object('status','error','detail','network'));
  if not exists(select 1 from public.daily_origin_cheapest_pool where snapshot_at='2099-01-01T03:30:00Z' and rank=2 and dest='QCC')
    or not exists(select 1 from public.offers where origin='FRA' and dest='QCC' and departure_at='2099-03-10')
    then raise exception 'technical error changed membership/offer'; end if;
end $$;
rollback;
