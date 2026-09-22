-- READ ONLY after owner applies 20260922140000_daily_window_candidates.sql.
select jsonb_pretty(jsonb_build_object(
  'checked_at',clock_timestamp(),
  'epoch_table',to_regclass('public.daily_window_candidate_epochs') is not null,
  'candidate_table',to_regclass('public.daily_window_candidates') is not null,
  'identity_map',to_regclass('public.destination_identity_map') is not null,
  'identity_rows',(select count(*) from public.destination_identity_map),
  'gva_identity',(select destination_id from public.destination_identity_map where dest='GVA'),
  'zrh_identity',(select destination_id from public.destination_identity_map where dest='ZRH'),
  'roulette_null_identity',(select count(*) from public.daily_origin_cheapest_pool where destination_id is null),
  'legacy_null_identity',(select count(*) from public.daily_origin_cheapest where destination_id is null),
  'publish_rpc',to_regprocedure('public.publish_daily_window_candidates(date,timestamptz,jsonb)') is not null,
  'refresh_rpc',to_regprocedure('public.collection_commit_window_candidate(uuid,bigint,jsonb,jsonb)') is not null,
  'epoch_rls',(select relrowsecurity from pg_class where oid=to_regclass('public.daily_window_candidate_epochs')),
  'candidate_rls',(select relrowsecurity from pg_class where oid=to_regclass('public.daily_window_candidates')),
  'anon_candidate_read',has_table_privilege('anon','public.daily_window_candidates','SELECT'),
  'anon_candidate_write',has_table_privilege('anon','public.daily_window_candidates','INSERT')
    or has_table_privilege('anon','public.daily_window_candidates','UPDATE')
    or has_table_privilege('anon','public.daily_window_candidates','DELETE'),
  'anon_refresh_execute',has_function_privilege('anon','public.collection_commit_window_candidate(uuid,bigint,jsonb,jsonb)','EXECUTE'),
  'service_refresh_execute',has_function_privilege('service_role','public.collection_commit_window_candidate(uuid,bigint,jsonb,jsonb)','EXECUTE'),
  'latest_epoch',(select to_jsonb(e) from public.daily_window_candidate_epochs e order by snapshot_at desc limit 1),
  'candidate_rows',(select count(*) from public.daily_window_candidates where snapshot_at=(select max(snapshot_at) from public.daily_window_candidates)),
  'request_groups',(select count(distinct concat_ws('|',origin,dest,departure_at,return_at)) from public.daily_window_candidates
    where snapshot_at=(select max(snapshot_at) from public.daily_window_candidates)),
  'null_destination_ids',(select count(*) from public.daily_window_candidates where snapshot_at=(select max(snapshot_at) from public.daily_window_candidates)
    and nullif(btrim(destination_id),'') is null),
  'duplicate_destinations',(select count(*) from (select origin,flight_type,departure_at,return_at,destination_id,count(*)
    from public.daily_window_candidates where snapshot_at=(select max(snapshot_at) from public.daily_window_candidates)
    group by 1,2,3,4,5 having count(*)>1) d),
  'bad_positions',(select count(*) from (select origin,flight_type,departure_at,return_at
    from public.daily_window_candidates where snapshot_at=(select max(snapshot_at) from public.daily_window_candidates)
    group by 1,2,3,4 having min(position)<>1 or max(position)<>count(*)) p),
  'invalid_regions',(select count(*) from public.daily_window_candidates c cross join lateral unnest(c.region_codes) r
    where r!~'^[A-Z]{2}(-[A-Z0-9]{1,3})?$'),
  'status_counts',(select jsonb_object_agg(refresh_status,n) from (select refresh_status,count(*) n from public.daily_window_candidates
    where snapshot_at=(select max(snapshot_at) from public.daily_window_candidates) group by refresh_status) s),
  'publish_definition',pg_get_functiondef('public.publish_daily_window_candidates(date,timestamptz,jsonb)'::regprocedure),
  'refresh_definition',pg_get_functiondef('public.collection_commit_window_candidate(uuid,bigint,jsonb,jsonb)'::regprocedure)
)) as daily_window_candidates_readback;
