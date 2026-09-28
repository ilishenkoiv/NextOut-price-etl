-- READ ONLY. Compact post-apply contract and privilege readback.
select
  position('if not found then return true' in pg_get_functiondef(p.oid))>0 as missing_target_is_noop,
  position('roulette target changed before confirmed-price sync' in pg_get_functiondef(p.oid))>0 as found_sync_fails_closed,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_role_can_execute,
  not has_function_privilege('anon',p.oid,'EXECUTE') as anon_cannot_execute,
  not has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_cannot_execute
from pg_proc p
where p.oid='public.collection_commit_roulette(uuid,bigint,jsonb,jsonb)'::regprocedure;

select pg_get_functiondef('public.collection_commit_roulette(uuid,bigint,jsonb,jsonb)'::regprocedure);
