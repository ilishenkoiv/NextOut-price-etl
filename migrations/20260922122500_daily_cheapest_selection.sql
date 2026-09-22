-- Atomic once-per-Berlin-day publication of rank-1 compatibility rows + immutable roulette pool.
-- A failed statement rolls back the marker and both row sets; a pre-03:30 trigger never calls it.
-- APPLY MANUALLY only after PO acceptance. Readback:
--   select observed_on,snapshot_at,completed_at from public.daily_cheapest_selection_runs order by observed_on desc limit 10;
-- Rollback code first, then:
--   drop function if exists public.publish_daily_cheapest_selection(date,timestamptz,jsonb,jsonb,boolean);
--   alter table public.daily_cheapest_selection_runs rename to daily_cheapest_selection_runs_rollback_20260922;
begin;
create table if not exists public.daily_cheapest_selection_runs(
  observed_on date primary key,
  snapshot_at timestamptz not null unique,
  completed_at timestamptz not null default clock_timestamp()
);
alter table public.daily_cheapest_selection_runs enable row level security;
revoke all on table public.daily_cheapest_selection_runs from public,anon,authenticated;
grant select,insert,update,delete on table public.daily_cheapest_selection_runs to service_role;

create or replace function public.publish_daily_cheapest_selection(p_observed_on date,p_snapshot_at timestamptz,
  p_rank1 jsonb,p_pool jsonb,p_force boolean default false)
returns boolean language plpgsql security definer set search_path=public as $$
declare inserted integer;
begin
  if p_observed_on is null or p_snapshot_at is null or jsonb_typeof(p_rank1)<>'array' or jsonb_array_length(p_rank1)=0
    or jsonb_typeof(p_pool)<>'array' or jsonb_array_length(p_pool)=0 then raise exception 'invalid daily selection'; end if;
  if exists(select 1 from jsonb_array_elements(p_rank1) r where (r->>'observed_on')::date is distinct from p_observed_on
    or (r->>'snapshot_at')::timestamptz is distinct from p_snapshot_at)
    or exists(select 1 from jsonb_array_elements(p_pool) r where (r->>'observed_on')::date is distinct from p_observed_on
    or (r->>'snapshot_at')::timestamptz is distinct from p_snapshot_at) then raise exception 'mixed daily selection epoch'; end if;
  perform pg_advisory_xact_lock(hashtext('daily-cheapest:'||p_observed_on::text));
  if p_force then
    delete from public.daily_cheapest_selection_runs where observed_on=p_observed_on;
  end if;
  insert into public.daily_cheapest_selection_runs(observed_on,snapshot_at) values(p_observed_on,p_snapshot_at)
    on conflict(observed_on) do nothing;
  get diagnostics inserted=row_count;
  if inserted=0 then return false; end if;
  -- Atomic takeover is compatible with a same-day legacy snapshot that predates the marker table.
  delete from public.daily_origin_cheapest_pool where observed_on=p_observed_on;
  delete from public.daily_origin_cheapest where observed_on=p_observed_on;
  insert into public.daily_origin_cheapest
    select * from jsonb_populate_recordset(null::public.daily_origin_cheapest,p_rank1);
  insert into public.daily_origin_cheapest_pool
    select * from jsonb_populate_recordset(null::public.daily_origin_cheapest_pool,p_pool);
  delete from public.daily_origin_cheapest_pool where snapshot_at<clock_timestamp()-interval '31 days';
  return true;
end;
$$;
revoke all on function public.publish_daily_cheapest_selection(date,timestamptz,jsonb,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.publish_daily_cheapest_selection(date,timestamptz,jsonb,jsonb,boolean) to service_role;
commit;
notify pgrst, 'reload schema';
