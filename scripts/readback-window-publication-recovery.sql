-- Read-only verification after applying 20260927120000_publish_daily_window_candidate_statuses.sql.
-- Run in the Supabase SQL editor; this does not acquire or modify the collection lease.
with berlin_today as (
  select (clock_timestamp() at time zone 'Europe/Berlin')::date as day
), current_epoch as (
  select e.* from public.daily_window_candidate_epochs e,berlin_today t
  where e.observed_on=t.day order by e.snapshot_at desc limit 1
), status_counts as (
  select c.refresh_status,count(*)::integer n from public.daily_window_candidates c,current_epoch e
  where c.snapshot_at=e.snapshot_at group by c.refresh_status
), ordering_errors as (
  select count(*)::integer n from (
    select c.origin,c.flight_type,c.departure_at,c.return_at
    from public.daily_window_candidates c,current_epoch e where c.snapshot_at=e.snapshot_at
    group by 1,2,3,4 having min(c.position)<>1 or max(c.position)<>count(*)
      or count(*)<>count(distinct c.destination_id)
  ) bad
)
select jsonb_pretty(jsonb_build_object(
  'checked_at',clock_timestamp(),
  'berlin_day',(select day from berlin_today),
  'publisher_definition',pg_get_functiondef('public.publish_daily_window_candidates(date,timestamptz,jsonb)'::regprocedure),
  'current_epoch',(select to_jsonb(e) from current_epoch e),
  'candidate_rows',(select count(*) from public.daily_window_candidates c,current_epoch e where c.snapshot_at=e.snapshot_at),
  'request_groups',(select count(distinct concat_ws('|',c.origin,c.dest,c.departure_at,c.return_at))
    from public.daily_window_candidates c,current_epoch e where c.snapshot_at=e.snapshot_at),
  'status_counts',(select jsonb_object_agg(refresh_status,n) from status_counts),
  'null_identity_rows',(select count(*) from public.daily_window_candidates c,current_epoch e
    where c.snapshot_at=e.snapshot_at and nullif(btrim(c.destination_id),'') is null),
  'ordering_errors',(select n from ordering_errors),
  'daily_selection_checkpoint',(select checkpoint->'dailySelection' from public.collection_scheduler_state where singleton),
  'main_checkpoint',(select checkpoint->'jobs'->'main' from public.collection_scheduler_state where singleton),
  'fast_checkpoint',(select checkpoint->'jobs'->'fast' from public.collection_scheduler_state where singleton),
  'tail_checkpoint',(select checkpoint->'jobs'->'tail' from public.collection_scheduler_state where singleton)
)) as window_publication_recovery_readback;
