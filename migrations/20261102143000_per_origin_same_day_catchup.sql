-- Owner-applied source repair, 2026-11-02.
-- A legacy global marker is not evidence that every per-origin marker exists.  It must not
-- suppress a current-day origin publication built from already collected, validated offers.
begin;
set local lock_timeout='10s';

create or replace function public.publish_daily_cheapest_origin_selection(
  p_observed_on date,p_snapshot_at timestamptz,p_origin text,p_rank1 jsonb,p_pool jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare inserted integer; existing_pool integer; existing_rank1 integer;
begin
  if p_observed_on is null or p_snapshot_at is null or p_origin !~ '^[A-Z]{3}$'
    or jsonb_typeof(p_rank1)<>'array' or jsonb_array_length(p_rank1)=0
    or jsonb_typeof(p_pool)<>'array' or jsonb_array_length(p_pool)<>10 then
    raise exception 'invalid per-origin daily selection';
  end if;
  if exists(select 1 from jsonb_array_elements(p_rank1) r where
      (r->>'observed_on')::date is distinct from p_observed_on
      or (r->>'snapshot_at')::timestamptz is distinct from p_snapshot_at
      or r->>'origin' is distinct from p_origin or coalesce((r->>'price')::numeric,0)<=0)
    or exists(select 1 from jsonb_array_elements(p_pool) r where
      (r->>'observed_on')::date is distinct from p_observed_on
      or (r->>'snapshot_at')::timestamptz is distinct from p_snapshot_at
      or r->>'origin' is distinct from p_origin or coalesce((r->>'price')::numeric,0)<=0
      or coalesce(r->>'dest','')!~'^[A-Z]{3}$' or coalesce(r->>'flight_type','') not in ('any','direct')
      or coalesce((r->>'rank')::integer,0) not between 1 and 10) then
    raise exception 'invalid per-origin daily selection';
  end if;
  if exists(select 1 from jsonb_array_elements(p_pool) r where not exists(
      select 1 from jsonb_array_elements(p_rank1) q where q->>'origin'=r->>'origin')) then
    raise exception 'daily roulette origin missing rank-1 compatibility row';
  end if;
  if (select count(distinct (r->>'rank')::integer) from jsonb_array_elements(p_pool) r)<>10
    or (select min((r->>'rank')::integer) from jsonb_array_elements(p_pool) r)<>1
    or (select max((r->>'rank')::integer) from jsonb_array_elements(p_pool) r)<>10
    or (select count(distinct r->>'dest') from jsonb_array_elements(p_pool) r)<>10 then
    raise exception 'daily roulette origin must contain ten unique cities ranked 1-10';
  end if;
  perform pg_advisory_xact_lock(hashtext('daily-cheapest-origin:'||p_observed_on::text||':'||p_origin));
  -- Do not consult daily_cheapest_selection_runs here: it is the old global checkpoint that
  -- caused the outage.  A completed origin marker remains the sole idempotency checkpoint.
  insert into public.daily_cheapest_origin_selection_runs(observed_on,origin,snapshot_at)
    values(p_observed_on,p_origin,p_snapshot_at) on conflict(observed_on,origin) do nothing;
  get diagnostics inserted=row_count;
  if inserted=0 then return false; end if;
  select count(*) into existing_pool from public.daily_origin_cheapest_pool
    where observed_on=p_observed_on and origin=p_origin;
  select count(*) into existing_rank1 from public.daily_origin_cheapest
    where observed_on=p_observed_on and origin=p_origin;
  -- A same-day legacy origin payload is already factual.  Adopt it by writing only the missing
  -- marker; never overwrite its membership or use an older epoch as a replacement ticket.
  if existing_pool>0 or existing_rank1>0 then
    -- The legacy rows are adopted only when they are a complete, compatible roulette
    -- payload.  Raising here rolls back the marker inserted above with this transaction.
    if existing_pool<>10 or existing_rank1<1
      or exists(select 1 from public.daily_origin_cheapest_pool p
        where p.observed_on=p_observed_on and p.origin=p_origin and (
          p.snapshot_at is distinct from p_snapshot_at or p.price<=0
          or p.rank not between 1 and 10 or p.dest !~ '^[A-Z]{3}$'))
      or (select count(distinct p.rank) from public.daily_origin_cheapest_pool p
        where p.observed_on=p_observed_on and p.origin=p_origin)<>10
      or (select min(p.rank) from public.daily_origin_cheapest_pool p
        where p.observed_on=p_observed_on and p.origin=p_origin)<>1
      or (select max(p.rank) from public.daily_origin_cheapest_pool p
        where p.observed_on=p_observed_on and p.origin=p_origin)<>10
      or (select count(distinct p.dest) from public.daily_origin_cheapest_pool p
        where p.observed_on=p_observed_on and p.origin=p_origin)<>10
      or not exists(select 1 from public.daily_origin_cheapest r
        join public.daily_origin_cheapest_pool p on p.observed_on=r.observed_on and p.snapshot_at=r.snapshot_at
          and p.origin=r.origin and p.flight_type=r.flight_type and p.dest=r.dest and p.rank=1
        where r.observed_on=p_observed_on and r.origin=p_origin and r.snapshot_at=p_snapshot_at
          and r.price>0 and r.dest~'^[A-Z]{3}$' and r.flight_type in ('any','direct')) then
      raise exception 'invalid pre-existing daily selection without per-origin marker';
    end if;
    return true;
  end if;
  insert into public.daily_origin_cheapest select * from jsonb_populate_recordset(null::public.daily_origin_cheapest,p_rank1);
  insert into public.daily_origin_cheapest_pool select * from jsonb_populate_recordset(null::public.daily_origin_cheapest_pool,p_pool);
  return true;
end;
$$;

revoke all on function public.publish_daily_cheapest_origin_selection(date,timestamptz,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.publish_daily_cheapest_origin_selection(date,timestamptz,text,jsonb,jsonb) to service_role;
commit;
notify pgrst,'reload schema';
