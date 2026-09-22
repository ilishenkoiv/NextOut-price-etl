-- READ ONLY. Run after 20260922130000_roulette_targeted_replacement.sql and before publishing code.
-- Keep collection paused. This does not execute the function or change production data.
select
  to_regclass('public.roulette_pool_replacements') is not null as audit_table_exists,
  to_regprocedure('public.collection_commit_roulette(uuid,bigint,jsonb,jsonb)') is not null as rpc_exists,
  has_function_privilege('service_role','public.collection_commit_roulette(uuid,bigint,jsonb,jsonb)','EXECUTE') as service_role_can_execute,
  not has_function_privilege('anon','public.collection_commit_roulette(uuid,bigint,jsonb,jsonb)','EXECUTE') as anon_cannot_execute,
  not has_function_privilege('authenticated','public.collection_commit_roulette(uuid,bigint,jsonb,jsonb)','EXECUTE') as authenticated_cannot_execute;

select
  p.oid::regprocedure as function,
  r.rolname as owner,
  p.prosecdef as security_definer,
  p.proconfig,
  p.proacl,
  md5(pg_get_functiondef(p.oid)) as definition_md5,
  position('is distinct from ''no_result''' in pg_get_functiondef(p.oid))>0 as null_status_guard,
  position('allowed is null' in pg_get_functiondef(p.oid))>0 as null_allowed_guard,
  position('t.flight_type is null' in pg_get_functiondef(p.oid))>0 as null_mode_guard,
  position('historical_rows_removed' in pg_get_functiondef(p.oid))>0 as audited_history_delete,
  position('candidate.updated_at<clock_timestamp()-interval ''30 minutes''' in pg_get_functiondef(p.oid))>0 as live_verification_guard,
  position('candidate.flight_type is distinct from t.flight_type' in pg_get_functiondef(p.oid))>0 as same_mode_guard,
  position('for update' in lower(pg_get_functiondef(p.oid)))>0 as fenced_and_locked
from pg_proc p
join pg_namespace n on n.oid=p.pronamespace
join pg_roles r on r.oid=p.proowner
where n.nspname='public' and p.oid='public.collection_commit_roulette(uuid,bigint,jsonb,jsonb)'::regprocedure;

select ordinal_position,column_name,data_type,is_nullable
from information_schema.columns
where table_schema='public' and table_name='roulette_pool_replacements'
order by ordinal_position;

select pg_get_functiondef('public.collection_commit_roulette(uuid,bigint,jsonb,jsonb)'::regprocedure) as exact_function_definition;
