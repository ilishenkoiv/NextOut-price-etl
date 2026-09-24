-- Production-safe controlled proof after 20260922130000 is applied. Schedules must stay paused.
-- All synthetic QAA/QBB/QCC/QDD rows and scheduler changes roll back with this transaction.
begin;
set local lock_timeout='10s';
do $$ declare test_owner uuid:='00000000-0000-4000-8000-000000000099'; f bigint; ok boolean;
  before_current integer; after_current integer; pool_before jsonb; observed_at timestamptz;
begin
  select fence into f from public.collection_scheduler_state where singleton and owner is null and lease_until is null for update;
  if f is null then raise exception 'scheduler is not idle'; end if;
  update public.collection_scheduler_state set owner=test_owner,fence=f+1,run_id='replacement-sql-test',
    lease_until=clock_timestamp()+interval '10 minutes' where singleton;
  insert into public.offers(origin,market,dest,month,flight_type,departure_at,return_at,nights,price,transfers,updated_at,price_source)
    values('FRA','de','QAA','2099-01','any','2099-01-10','2099-01-17',7,999,1,clock_timestamp(),'{}'),
          ('FRA','de','QBB','2099-02','any','2099-02-10','2099-02-17',7,123,0,clock_timestamp(),'{}'),
          ('FRA','de','QCC','2099-03','any','2099-03-10','2099-03-17',7,555,1,clock_timestamp(),'{}'),
          ('FRA','de','QDD','2099-04','any','2099-04-10','2099-04-17',7,777,1,clock_timestamp(),'{}');
  insert into public.daily_origin_cheapest_pool(observed_on,snapshot_at,origin,market,flight_type,rank,dest,price,currency,
    departure_at,return_at,transfers,source_updated_at,price_source)
    values('2099-01-01','2099-01-01T03:30:00Z','FRA','de','any',1,'QAA',999,'EUR','2099-01-10','2099-01-17',1,clock_timestamp(),'{}'),
          ('2099-01-01','2099-01-01T03:30:00Z','FRA','de','any',2,'QCC',555,'EUR','2099-03-10','2099-03-17',1,clock_timestamp(),'{}'),
          ('2099-01-01','2099-01-01T03:30:00Z','FRA','de','any',3,'QDD',777,'EUR','2099-04-10','2099-04-17',1,clock_timestamp(),'{}'),
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
  -- Since 20260924070000, a successful observation refreshes the offer AND the exact pool row
  -- (price/source_updated_at) in the same transaction; identity (snapshot_at/origin/flight_type/
  -- rank/dest/departure_at/return_at) stays exactly as selected — only price/source_updated_at move.
  select to_jsonb(p) into pool_before from public.daily_origin_cheapest_pool p
    where snapshot_at='2099-01-01T03:30:00Z' and origin='FRA' and flight_type='any' and rank=2;
  observed_at:=clock_timestamp();
  perform public.collection_commit_roulette(test_owner,f+1,
    jsonb_build_object('observed_on','2099-01-01','snapshot_at','2099-01-01T03:30:00Z','origin','FRA',
      'flight_type','any','rank',2,'dest','QCC','departure_at','2099-03-10','return_at','2099-03-17'),
    jsonb_build_object('status','found','price',555,'transfers',1,'updated_at',observed_at,'price_source','{}'::jsonb));
  if not exists(select 1 from public.offers where origin='FRA' and dest='QCC' and departure_at='2099-03-10'
      and price=555 and updated_at=observed_at)
    or not exists(select 1 from public.daily_origin_cheapest_pool p
      where snapshot_at='2099-01-01T03:30:00Z' and origin='FRA' and flight_type='any' and rank=2
        and dest='QCC' and price=555 and source_updated_at=observed_at)
    or (pool_before->>'dest') is distinct from 'QCC'
    then raise exception 'unchanged confirmed price did not sync offer+pool identically'; end if;
  perform public.collection_commit_roulette(test_owner,f+1,
    jsonb_build_object('observed_on','2099-01-01','snapshot_at','2099-01-01T03:30:00Z','origin','FRA',
      'flight_type','any','rank',2,'dest','QCC','departure_at','2099-03-10','return_at','2099-03-17'),
    jsonb_build_object('status','found','price',600,'transfers',1,'updated_at',clock_timestamp(),'price_source','{}'::jsonb));
  if not exists(select 1 from public.offers where origin='FRA' and dest='QCC' and departure_at='2099-03-10' and price=600)
    or not exists(select 1 from public.daily_origin_cheapest_pool p
      where snapshot_at='2099-01-01T03:30:00Z' and origin='FRA' and flight_type='any' and rank=2 and dest='QCC' and price=600)
    then raise exception 'confirmed price increase was not stored in offer and pool'; end if;
  perform public.collection_commit_roulette(test_owner,f+1,
    jsonb_build_object('observed_on','2099-01-01','snapshot_at','2099-01-01T03:30:00Z','origin','FRA',
      'flight_type','any','rank',2,'dest','QCC','departure_at','2099-03-10','return_at','2099-03-17'),
    jsonb_build_object('status','found','price',500,'transfers',1,'updated_at',clock_timestamp(),'price_source','{}'::jsonb));
  if not exists(select 1 from public.offers where origin='FRA' and dest='QCC' and departure_at='2099-03-10' and price=500)
    or not exists(select 1 from public.daily_origin_cheapest_pool p
      where snapshot_at='2099-01-01T03:30:00Z' and origin='FRA' and flight_type='any' and rank=2 and dest='QCC' and price=500)
    then raise exception 'confirmed price decrease was not stored in offer and pool'; end if;
  -- Missing/NULL status is an inconclusive technical result and must fail closed as a no-op.
  perform public.collection_commit_roulette(test_owner,f+1,
    jsonb_build_object('observed_on','2099-01-01','snapshot_at','2099-01-01T03:30:00Z','origin','FRA',
      'flight_type','any','rank',2,'dest','QCC','departure_at','2099-03-10','return_at','2099-03-17'),
    '{}'::jsonb);
  perform public.collection_commit_roulette(test_owner,f+1,
    jsonb_build_object('observed_on','2099-01-01','snapshot_at','2099-01-01T03:30:00Z','origin','FRA',
      'flight_type','any','rank',2,'dest','QCC','departure_at','2099-03-10','return_at','2099-03-17'),
    jsonb_build_object('status',null));
  if not exists(select 1 from public.daily_origin_cheapest_pool where snapshot_at='2099-01-01T03:30:00Z' and rank=2 and dest='QCC')
    or not exists(select 1 from public.offers where origin='FRA' and dest='QCC' and departure_at='2099-03-10')
    or exists(select 1 from public.roulette_pool_replacements where snapshot_at='2099-01-01T03:30:00Z' and rank=2)
    then raise exception 'null or missing status changed membership/offer'; end if;
  -- A real no_result may mutate only with a canonical non-empty allowed list and a non-NULL mode.
  begin
    perform public.collection_commit_roulette(test_owner,f+1,
      jsonb_build_object('observed_on','2099-01-01','snapshot_at','2099-01-01T03:30:00Z','origin','FRA',
        'flight_type','any','rank',2,'dest','QCC','departure_at','2099-03-10','return_at','2099-03-17'),
      jsonb_build_object('status','no_result','replacement',null));
    raise exception 'missing allowed destinations accepted';
  exception when others then
    if sqlerrm='missing allowed destinations accepted' or position('missing allowed destinations' in sqlerrm)=0 then raise; end if;
  end;
  begin
    perform public.collection_commit_roulette(test_owner,f+1,
      jsonb_build_object('observed_on','2099-01-01','snapshot_at','2099-01-01T03:30:00Z','origin','FRA',
        'flight_type','any','rank',2,'dest','QCC','departure_at','2099-03-10','return_at','2099-03-17','allowed_dests','[]'::jsonb),
      jsonb_build_object('status','no_result','replacement',null));
    raise exception 'empty allowed destinations accepted';
  exception when others then
    if sqlerrm='empty allowed destinations accepted' or position('invalid allowed destinations' in sqlerrm)=0 then raise; end if;
  end;
  begin
    perform public.collection_commit_roulette(test_owner,f+1,
      jsonb_build_object('observed_on','2099-01-01','snapshot_at','2099-01-01T03:30:00Z','origin','FRA',
        'flight_type',null,'rank',2,'dest','QCC','departure_at','2099-03-10','return_at','2099-03-17','allowed_dests',jsonb_build_array('QCC')),
      jsonb_build_object('status','no_result','replacement',null));
    raise exception 'null flight type accepted';
  exception when others then
    if sqlerrm='null flight type accepted' or position('invalid roulette ticket' in sqlerrm)=0 then raise; end if;
  end;
  if not exists(select 1 from public.daily_origin_cheapest_pool where snapshot_at='2099-01-01T03:30:00Z' and rank=2 and dest='QCC')
    or not exists(select 1 from public.offers where origin='FRA' and dest='QCC' and departure_at='2099-03-10')
    then raise exception 'null guard rejection changed membership/offer'; end if;
  -- A confirmed unavailable ticket with no live eligible alternative is explicitly exhausted and audited.
  perform public.collection_commit_roulette(test_owner,f+1,
    jsonb_build_object('observed_on','2099-01-01','snapshot_at','2099-01-01T03:30:00Z','origin','FRA','market','de',
      'flight_type','any','rank',3,'dest','QDD','price',777,'currency','EUR','departure_at','2099-04-10',
      'return_at','2099-04-17','transfers',1,'allowed_dests',jsonb_build_array('QDD'),'run_id','replacement-sql-test'),
    jsonb_build_object('status','no_result','replacement',null));
  if exists(select 1 from public.daily_origin_cheapest_pool where snapshot_at='2099-01-01T03:30:00Z' and rank=3 and dest='QDD')
    or exists(select 1 from public.offers where origin='FRA' and dest='QDD' and departure_at='2099-04-10')
    or not exists(select 1 from public.roulette_pool_replacements where snapshot_at='2099-01-01T03:30:00Z'
      and rank=3 and outcome='exhausted' and new_ticket is null and historical_rows_removed=1)
    then raise exception 'confirmed unavailable exhaustion was not explicit and audited'; end if;
  perform public.collection_commit_roulette(test_owner,f+1,
    jsonb_build_object('observed_on','2099-01-01','snapshot_at','2099-01-01T03:30:00Z','origin','FRA','market','de',
      'flight_type','any','rank',2,'dest','QCC','price',555,'currency','EUR','departure_at','2099-03-10',
      'return_at','2099-03-17','transfers',1,'allowed_dests',jsonb_build_array('QCC'),'run_id','replacement-sql-test'),
    jsonb_build_object('status','error','detail','network'));
  if not exists(select 1 from public.daily_origin_cheapest_pool where snapshot_at='2099-01-01T03:30:00Z' and rank=2 and dest='QCC')
    or not exists(select 1 from public.offers where origin='FRA' and dest='QCC' and departure_at='2099-03-10' and price=500)
    then raise exception 'technical error changed membership/offer'; end if;
end $$;
rollback;
