-- Read-only production verification after 20260927160000_route_dead_policy_transition.sql.
select jsonb_pretty(jsonb_build_object(
  'checked_at',clock_timestamp(),
  'berlin_now',clock_timestamp() at time zone 'Europe/Berlin',
  'record_definition',pg_get_functiondef('public.collection_record_route_observation(uuid,bigint,bigint,text,text,text,text[],boolean,boolean)'::regprocedure),
  'revive_definition',pg_get_functiondef('public.collection_revive_route(uuid,bigint,text,text,timestamptz)'::regprocedure),
  'status_policy_counts',(select jsonb_agg(to_jsonb(x)) from (
    select status,coalesce(dead_policy,'none') dead_policy,count(*) n from public.route_price_health group by 1,2 order by 1,2) x),
  'expired_temporary_rows',(select count(*) from public.route_price_health
    where status='dead' and dead_policy='temporary_immediate' and temporary_dead_until<=clock_timestamp()),
  'temporary_without_cutoff',(select count(*) from public.route_price_health
    where dead_policy='temporary_immediate' and temporary_dead_until is null),
  'permanent_before_7d',(select count(*) from public.route_price_health
    where status='dead' and dead_policy='permanent_7d'
      and first_confirmed_no_price_at>clock_timestamp()-interval '7 days'),
  'protected_permanent_rows',(select count(*) from public.route_price_health
    where status='dead' and dead_policy='permanent_7d' and protected_until>clock_timestamp()),
  'checkpoint',(select checkpoint from public.collection_scheduler_state where singleton)
)) as route_dead_policy_readback;
