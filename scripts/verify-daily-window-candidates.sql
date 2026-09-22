-- Transactional behavioral proof. Run with schedules paused; every QWA/QWB change rolls back.
begin;
set local lock_timeout='10s';
do $$ declare test_owner uuid:='00000000-0000-4000-8000-000000000098'; f bigint; published boolean;
  pool_before jsonb; observed timestamptz:=clock_timestamp();
begin
  select fence into f from public.collection_scheduler_state where singleton and owner is null and lease_until is null for update;
  if f is null then raise exception 'scheduler is not idle';end if;
  update public.collection_scheduler_state set owner=test_owner,fence=f+1,run_id='window-candidate-sql-test',
    lease_until=clock_timestamp()+interval '10 minutes' where singleton;
  published:=public.publish_daily_window_candidates('2099-01-01','2099-01-01T03:30:00Z',jsonb_build_array(
    jsonb_build_object('contract_version',1,'observed_on','2099-01-01','snapshot_at','2099-01-01T03:30:00Z',
      'origin','FRA','market','de','flight_type','any','region_codes',jsonb_build_array(),'window_kind','weekend',
      'departure_at','2099-01-15','return_at','2099-01-18','position',1,'dest','QWA','destination_id','fixture:qwa',
      'exact_price',100,'currency','EUR','transfers',1,'exact_observed_at',observed,'refresh_status','fresh',
      'refresh_checked_at',observed,'price_source','{}'::jsonb),
    jsonb_build_object('contract_version',1,'observed_on','2099-01-01','snapshot_at','2099-01-01T03:30:00Z',
      'origin','FRA','market','de','flight_type','any','region_codes',jsonb_build_array('DE-BY'),'window_kind','holiday',
      'departure_at','2099-02-10','return_at','2099-02-17','position',1,'dest','QWB','destination_id','fixture:qwb',
      'exact_price',200,'currency','EUR','transfers',1,'exact_observed_at',observed,'refresh_status','fresh',
      'refresh_checked_at',observed,'price_source','{}'::jsonb)));
  if not published or (select count(*) from public.daily_window_candidates where snapshot_at='2099-01-01T03:30:00Z')<>2
    then raise exception 'atomic daily candidate publication failed';end if;
  if public.publish_daily_window_candidates('2099-01-01','2099-01-01T03:30:00Z',
      (select jsonb_agg(to_jsonb(c)||jsonb_build_object('contract_version',1)) from public.daily_window_candidates c
        where snapshot_at='2099-01-01T03:30:00Z'))
    then raise exception 'duplicate daily publication accepted';end if;
  select to_jsonb(c)-'exact_price'-'transfers'-'airline'-'exact_observed_at'-'refresh_status'-'refresh_checked_at'-'last_error_kind'-'price_source'
    into pool_before from public.daily_window_candidates c where snapshot_at='2099-01-01T03:30:00Z' and dest='QWA';
  perform public.collection_commit_window_candidate(test_owner,f+1,
    jsonb_build_object('snapshot_at','2099-01-01T03:30:00Z','origin','FRA','flight_type','any','departure_at','2099-01-15',
      'return_at','2099-01-18','position',1,'destination_id','fixture:qwa'),
    jsonb_build_object('status','found','price',100,'transfers',1,'updated_at',clock_timestamp(),'price_source','{}'::jsonb));
  if not exists(select 1 from public.daily_window_candidates where dest='QWA' and exact_price=100 and refresh_status='fresh'
      and exact_observed_at>observed) then raise exception 'same-price refresh did not update observation';end if;
  perform public.collection_commit_window_candidate(test_owner,f+1,
    jsonb_build_object('snapshot_at','2099-01-01T03:30:00Z','origin','FRA','flight_type','any','departure_at','2099-01-15',
      'return_at','2099-01-18','position',1,'destination_id','fixture:qwa'),jsonb_build_object('status','found','price',125,
      'transfers',1,'updated_at',clock_timestamp(),'price_source','{}'::jsonb));
  perform public.collection_commit_window_candidate(test_owner,f+1,
    jsonb_build_object('snapshot_at','2099-01-01T03:30:00Z','origin','FRA','flight_type','any','departure_at','2099-01-15',
      'return_at','2099-01-18','position',1,'destination_id','fixture:qwa'),jsonb_build_object('status','found','price',90,
      'transfers',1,'updated_at',clock_timestamp(),'price_source','{}'::jsonb));
  if not exists(select 1 from public.daily_window_candidates where dest='QWA' and exact_price=90)
    or pool_before is distinct from (select to_jsonb(c)-'exact_price'-'transfers'-'airline'-'exact_observed_at'-'refresh_status'-'refresh_checked_at'-'last_error_kind'-'price_source'
      from public.daily_window_candidates c where snapshot_at='2099-01-01T03:30:00Z' and dest='QWA')
    then raise exception 'price refresh changed membership/order or rejected increase/decrease';end if;
  perform public.collection_commit_window_candidate(test_owner,f+1,
    jsonb_build_object('snapshot_at','2099-01-01T03:30:00Z','origin','FRA','flight_type','any','departure_at','2099-01-15',
      'return_at','2099-01-18','position',1,'destination_id','fixture:qwa'),jsonb_build_object('status','error','detail','timeout'));
  if not exists(select 1 from public.daily_window_candidates where dest='QWA' and exact_price=90 and refresh_status='failed')
    then raise exception 'technical failure erased/freshened saved price';end if;
  perform public.collection_commit_window_candidate(test_owner,f+1,
    jsonb_build_object('snapshot_at','2099-01-01T03:30:00Z','origin','FRA','flight_type','any','departure_at','2099-01-15',
      'return_at','2099-01-18','position',1,'destination_id','fixture:qwa'),jsonb_build_object('status','no_result'));
  if not exists(select 1 from public.daily_window_candidates where dest='QWA' and exact_price=90 and refresh_status='unavailable')
    then raise exception 'unavailable result removed membership/history';end if;
end $$;
rollback;
