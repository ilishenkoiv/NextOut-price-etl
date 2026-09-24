-- Production-safe disposable proof for 20260924070000_roulette_pool_found_sync.sql.
-- Only synthetic ZQA/ZQB rows and a scoped scheduler lease are touched; everything rolls back.
begin;
set local lock_timeout='10s';
do $$ declare test_owner uuid:='00000000-0000-4000-8000-000000000098'; f bigint; ok boolean;
  pool_price numeric; pool_src timestamptz; observed_at timestamptz; offers_price numeric;
begin
  select fence into f from public.collection_scheduler_state where singleton and owner is null and lease_until is null for update;
  if f is null then raise exception 'scheduler is not idle'; end if;
  update public.collection_scheduler_state set owner=test_owner,fence=f+1,run_id='pool-found-sync-test',
    lease_until=clock_timestamp()+interval '10 minutes' where singleton;
  insert into public.offers(origin,market,dest,month,flight_type,departure_at,return_at,nights,price,transfers,updated_at,price_source)
    values('FRA','de','ZQA','2099-05','any','2099-05-10','2099-05-17',7,300,1,clock_timestamp()-interval '20 minutes','{}');
  insert into public.daily_origin_cheapest_pool(observed_on,snapshot_at,origin,market,flight_type,rank,dest,price,currency,
    departure_at,return_at,transfers,source_updated_at,price_source)
    values('2099-05-01','2099-05-01T03:30:00Z','FRA','de','any',1,'ZQA',300,'EUR','2099-05-10','2099-05-17',1,
      clock_timestamp()-interval '20 minutes','{}');

  -- 1) Normal confirmed refresh: offers AND pool must both move to the new price/timestamp.
  observed_at:=clock_timestamp();
  ok:=public.collection_commit_roulette(test_owner,f+1,
    jsonb_build_object('observed_on','2099-05-01','snapshot_at','2099-05-01T03:30:00Z','origin','FRA',
      'flight_type','any','rank',1,'dest','ZQA','departure_at','2099-05-10','return_at','2099-05-17'),
    jsonb_build_object('status','found','price',275,'transfers',1,'updated_at',observed_at,'price_source','{}'::jsonb));
  select price into offers_price from public.offers where origin='FRA' and dest='ZQA' and departure_at='2099-05-10';
  select price,source_updated_at into pool_price,pool_src from public.daily_origin_cheapest_pool
    where snapshot_at='2099-05-01T03:30:00Z' and origin='FRA' and flight_type='any' and rank=1 and dest='ZQA';
  if not ok or offers_price<>275 or pool_price<>275 or pool_src<>observed_at
    then raise exception 'found path did not sync pool price/source_updated_at'; end if;

  -- 2) Identity mismatch on a FRESH observation (ticket names a rank/dest that no longer matches
  -- the pool row): must raise, never silently return true with nothing written. A mismatch is
  -- only even checked once an observation is fresh enough to be worth writing — see (3).
  begin
    perform public.collection_commit_roulette(test_owner,f+1,
      jsonb_build_object('observed_on','2099-05-01','snapshot_at','2099-05-01T03:30:00Z','origin','FRA',
        'flight_type','any','rank',2,'dest','ZQA','departure_at','2099-05-10','return_at','2099-05-17'),
      jsonb_build_object('status','found','price',999,'transfers',1,'updated_at',clock_timestamp(),'price_source','{}'::jsonb));
    raise exception 'identity mismatch accepted as success';
  exception when others then
    if sqlerrm='identity mismatch accepted as success' or position('roulette target changed before confirmed-price sync' in sqlerrm)=0 then raise; end if;
  end;
  -- A PL/pgSQL function call is atomic: raising anywhere in it rolls back every write that same
  -- call made, including the offers update earlier in the SAME 'found' branch. So a genuine
  -- identity mismatch correctly leaves BOTH offers and pool untouched — never a partial write.
  if exists(select 1 from public.offers where origin='FRA' and dest='ZQA' and departure_at='2099-05-10' and price=999)
    then raise exception 'identity mismatch left a partial write in offers despite raising'; end if;

  -- 3) Stale provider response (older than the 30-minute freshness window) for a ticket whose
  -- identity DOES still match: must NOT raise (one flaky/slow provider response must never abort
  -- the whole 30-minute collection run), must still update offers exactly as before, but must
  -- leave the pool price/source_updated_at exactly as they were — never declared fresh.
  ok:=public.collection_commit_roulette(test_owner,f+1,
    jsonb_build_object('observed_on','2099-05-01','snapshot_at','2099-05-01T03:30:00Z','origin','FRA',
      'flight_type','any','rank',1,'dest','ZQA','departure_at','2099-05-10','return_at','2099-05-17'),
    jsonb_build_object('status','found','price',111,'transfers',1,'updated_at',clock_timestamp()-interval '45 minutes','price_source','{}'::jsonb));
  select price into offers_price from public.offers where origin='FRA' and dest='ZQA' and departure_at='2099-05-10';
  select price,source_updated_at into pool_price,pool_src from public.daily_origin_cheapest_pool
    where snapshot_at='2099-05-01T03:30:00Z' and origin='FRA' and flight_type='any' and rank=1 and dest='ZQA';
  if not ok then raise exception 'a single stale provider response aborted the run instead of a graceful no-op'; end if;
  if offers_price<>111 then raise exception 'stale provider response did not still update offers as before'; end if;
  if pool_price<>275 or pool_src<>observed_at then raise exception 'stale provider response changed the pool as if it were fresh'; end if;

  -- 3b) Boundary: an observation comfortably inside the 30-minute window (29 minutes — not exactly
  -- 30, since two separate clock_timestamp() evaluations a few ms apart would make an "exactly
  -- 30 minutes" fixture inherently racy) must sync the pool, not be treated as stale.
  ok:=public.collection_commit_roulette(test_owner,f+1,
    jsonb_build_object('observed_on','2099-05-01','snapshot_at','2099-05-01T03:30:00Z','origin','FRA',
      'flight_type','any','rank',1,'dest','ZQA','departure_at','2099-05-10','return_at','2099-05-17'),
    jsonb_build_object('status','found','price',222,'transfers',1,'updated_at',clock_timestamp()-interval '29 minutes','price_source','{}'::jsonb));
  select price into pool_price from public.daily_origin_cheapest_pool
    where snapshot_at='2099-05-01T03:30:00Z' and origin='FRA' and flight_type='any' and rank=1 and dest='ZQA';
  if not ok or pool_price<>222 then raise exception 'a 29-minute-old observation was wrongly treated as stale'; end if;

  -- 4) no_result / replacement path is unchanged by this migration: still replaces atomically.
  insert into public.offers(origin,market,dest,month,flight_type,departure_at,return_at,nights,price,transfers,updated_at,price_source)
    values('FRA','de','ZQB','2099-06','any','2099-06-10','2099-06-17',7,150,0,clock_timestamp(),'{}');
  ok:=public.collection_commit_roulette(test_owner,f+1,
    jsonb_build_object('observed_on','2099-05-01','snapshot_at','2099-05-01T03:30:00Z','origin','FRA','market','de',
      'flight_type','any','rank',1,'dest','ZQA','price',275,'currency','EUR','departure_at','2099-05-10',
      'return_at','2099-05-17','transfers',1,'allowed_dests',jsonb_build_array('ZQA','ZQB'),'run_id','pool-found-sync-test'),
    jsonb_build_object('status','no_result','replacement',jsonb_build_object('origin','FRA','market','de','dest','ZQB',
      'month','2099-06','flight_type','any','departure_at','2099-06-10','return_at','2099-06-17','nights',7,
      'price',150,'transfers',0,'updated_at',clock_timestamp(),'price_source','{}'::jsonb)));
  if not ok or exists(select 1 from public.daily_origin_cheapest_pool where snapshot_at='2099-05-01T03:30:00Z' and rank=1 and dest='ZQA')
    or not exists(select 1 from public.daily_origin_cheapest_pool where snapshot_at='2099-05-01T03:30:00Z' and rank=1 and dest='ZQB')
    then raise exception 'no_result replacement path regressed'; end if;

  raise notice 'roulette pool found-sync proof passed';
end $$;
rollback;
