-- Exact rollback: remove only the external coordinator cron and its wrapper.
-- Collection data, scheduler state and checkpoints are untouched.

begin;

do $rollback$
declare
  target_job record;
begin
  if to_regclass('cron.job') is not null then
    for target_job in execute
      $query$select jobid from cron.job where jobname = 'nextout-etl-coordinator-dispatch-5m'$query$
    loop
      execute 'select cron.unschedule($1)' using target_job.jobid;
    end loop;
  end if;
end
$rollback$;

drop function if exists public.nextout_dispatch_etl_coordinator();

commit;
