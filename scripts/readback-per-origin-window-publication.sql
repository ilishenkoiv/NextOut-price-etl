-- READ ONLY after owner applies 20261102123000_per_origin_window_publication.sql.
with berlin_today as (select (clock_timestamp() at time zone 'Europe/Berlin')::date observed_on)
select jsonb_pretty(jsonb_build_object(
  'checked_at',clock_timestamp(),
  'origin_marker_table',to_regclass('public.daily_origin_window_candidate_runs') is not null,
  'origin_candidate_table',to_regclass('public.daily_origin_window_candidates') is not null,
  'origin_publish_rpc',to_regprocedure('public.publish_daily_origin_window_candidates(date,timestamptz,text,jsonb)') is not null,
  'legacy_global_publish_rpc',to_regprocedure('public.publish_daily_window_candidates(date,timestamptz,jsonb)') is not null,
  'today_origin_markers',(select coalesce(jsonb_agg(to_jsonb(r) order by r.origin),'[]'::jsonb)
    from public.daily_origin_window_candidate_runs r,berlin_today t where r.observed_on=t.observed_on),
  'today_candidate_counts',(select coalesce(jsonb_object_agg(origin,n),'{}'::jsonb) from (
    select c.origin,count(*) n from public.daily_origin_window_candidates c,berlin_today t
    where c.observed_on=t.observed_on group by c.origin) counts),
  'cross_origin_duplicate_slots',(select count(*) from (
    select observed_on,origin,flight_type,departure_at,return_at,position,count(*) from public.daily_origin_window_candidates
    group by 1,2,3,4,5,6 having count(*)>1) d),
  'stale_fallbacks',(select count(*) from public.daily_origin_window_candidates
    where price_source->'carousel_fallback'->>'kind'='previous_day_same_origin_mode_dates'),
  'origin_publish_definition',pg_get_functiondef('public.publish_daily_origin_window_candidates(date,timestamptz,text,jsonb)'::regprocedure)
)) as per_origin_window_publication_readback;
