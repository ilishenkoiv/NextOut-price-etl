-- Read-only production verification after 20260927160000_route_dead_policy_transition.sql.
select jsonb_pretty(jsonb_build_object(
  'checked_at',clock_timestamp(),
  'berlin_now',clock_timestamp() at time zone 'Europe/Berlin',
  'record_definition',pg_get_functiondef('public.collection_record_route_observation(uuid,bigint,bigint,text,text,text,text[],boolean,boolean)'::regprocedure),
  'revive_definition',pg_get_functiondef('public.collection_revive_route(uuid,bigint,text,text,timestamptz)'::regprocedure),
  'execute_privileges',(select jsonb_agg(jsonb_build_object(
    'function',p.oid::regprocedure::text,
    'service_role',has_function_privilege('service_role',p.oid,'EXECUTE'),
    'public',exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
      where a.grantee=0 and a.privilege_type='EXECUTE'),
    'anon',has_function_privilege('anon',p.oid,'EXECUTE'),
    'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE')
  ) order by p.oid::regprocedure::text) from pg_proc p where p.oid in (
    'public.collection_record_route_observation(uuid,bigint,bigint,text,text,text,text[],boolean,boolean)'::regprocedure,
    'public.collection_revive_route(uuid,bigint,text,text,timestamptz)'::regprocedure
  )),
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
