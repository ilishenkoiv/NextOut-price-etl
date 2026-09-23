-- Reviewed owner-run SQL: install exactly one five-minute trigger for the existing coordinator.
-- Prerequisite: store the fine-grained GitHub token directly in Supabase Vault with the name
-- `nextout_github_workflow_dispatch_token`. Never paste the token into this script.

begin;

do $preflight$
declare
  matching_secrets integer;
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise exception 'Preflight failed: pg_cron is not enabled';
  end if;
  if not exists (select 1 from pg_extension where extname = 'pg_net') then
    raise exception 'Preflight failed: pg_net is not enabled';
  end if;
  if to_regclass('vault.decrypted_secrets') is null then
    raise exception 'Preflight failed: Supabase Vault is not available';
  end if;

  select count(*) into matching_secrets
  from vault.decrypted_secrets
  where name = 'nextout_github_workflow_dispatch_token';
  if matching_secrets <> 1 then
    raise exception 'Preflight failed: expected exactly one Vault secret named nextout_github_workflow_dispatch_token';
  end if;

  if exists (
    select 1 from cron.job
    where active
      and jobname <> 'nextout-etl-coordinator-dispatch-5m'
      and (command ilike '%nextout_dispatch_etl_coordinator%'
        or command ilike '%collection-coordinator.yml%/dispatches%')
  ) then
    raise exception 'Preflight failed: another active equivalent coordinator trigger already exists';
  end if;
end
$preflight$;

create or replace function public.nextout_dispatch_etl_coordinator()
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  github_token text;
  request_id bigint;
begin
  select decrypted_secret into github_token
  from vault.decrypted_secrets
  where name = 'nextout_github_workflow_dispatch_token';

  if github_token is null or length(github_token) < 20 then
    raise exception 'GitHub dispatch credential is unavailable';
  end if;

  select net.http_post(
    url := 'https://api.github.com/repos/ilishenkoiv/NextOut-price-etl/actions/workflows/collection-coordinator.yml/dispatches',
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || github_token,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'nextout-supabase-cron'
    ),
    body := jsonb_build_object(
      'ref', 'main',
      'inputs', jsonb_build_object('trigger_source', 'supabase-cron')
    ),
    timeout_milliseconds := 10000
  ) into request_id;

  raise log 'nextout coordinator dispatch queued request_id=% source=supabase-cron', request_id;
  return request_id;
end
$function$;

revoke all on function public.nextout_dispatch_etl_coordinator() from public, anon, authenticated;

select cron.schedule(
  'nextout-etl-coordinator-dispatch-5m',
  '*/5 * * * *',
  $command$select public.nextout_dispatch_etl_coordinator();$command$
);

commit;

-- Non-secret installation readback.
select jobid, jobname, schedule, active
from cron.job
where jobname = 'nextout-etl-coordinator-dispatch-5m';
