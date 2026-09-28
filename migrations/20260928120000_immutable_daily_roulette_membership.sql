-- Freeze each Berlin day's roulette membership and retain the last real price on every
-- non-found refresh outcome. The historical roulette_pool_replacements table is intentionally
-- left intact for audit/reference, but neither function below reads or writes it.
begin;
set local lock_timeout='10s';

create or replace function public.publish_daily_cheapest_selection(p_observed_on date,p_snapshot_at timestamptz,
  p_rank1 jsonb,p_pool jsonb,p_force boolean default false)
returns boolean language plpgsql security definer set search_path=public as $$
declare inserted integer;
begin
  if p_observed_on is null or p_snapshot_at is null or jsonb_typeof(p_rank1)<>'array' or jsonb_array_length(p_rank1)=0
    or jsonb_typeof(p_pool)<>'array' or jsonb_array_length(p_pool)=0 then raise exception 'invalid daily selection'; end if;
  if exists(select 1 from jsonb_array_elements(p_rank1) r where (r->>'observed_on')::date is distinct from p_observed_on
      or (r->>'snapshot_at')::timestamptz is distinct from p_snapshot_at or coalesce((r->>'price')::numeric,0)<=0)
    or exists(select 1 from jsonb_array_elements(p_pool) r where (r->>'observed_on')::date is distinct from p_observed_on
      or (r->>'snapshot_at')::timestamptz is distinct from p_snapshot_at or coalesce((r->>'price')::numeric,0)<=0
      or coalesce(r->>'origin','')!~'^[A-Z]{3}$' or coalesce(r->>'dest','')!~'^[A-Z]{3}$'
      or coalesce(r->>'flight_type','') not in ('any','direct') or coalesce((r->>'rank')::integer,0) not between 1 and 10)
    then raise exception 'invalid daily selection'; end if;
  if exists(
    select origin from (
      select r->>'origin' origin,(r->>'rank')::integer rank,r->>'dest' dest
      from jsonb_array_elements(p_pool) r
    ) rows group by origin
    having count(*)<>10 or count(distinct rank)<>10 or min(rank)<>1 or max(rank)<>10 or count(distinct dest)<>10
  ) then raise exception 'daily roulette origin must contain ten unique cities ranked 1-10'; end if;
  if exists(
    select 1 from jsonb_array_elements(p_pool) p
    where not exists(select 1 from jsonb_array_elements(p_rank1) r where r->>'origin'=p->>'origin')
  ) then raise exception 'daily roulette origin missing rank-1 compatibility row'; end if;

  perform pg_advisory_xact_lock(hashtext('daily-cheapest:'||p_observed_on::text));
  -- p_force may bypass the scheduler's time gate, but can never replace an existing Berlin day.
  if exists(select 1 from public.daily_cheapest_selection_runs where observed_on=p_observed_on) then return false; end if;
  if exists(select 1 from public.daily_origin_cheapest_pool where observed_on=p_observed_on)
    or exists(select 1 from public.daily_origin_cheapest where observed_on=p_observed_on)
    then raise exception 'pre-existing daily selection without epoch marker'; end if;

  insert into public.daily_cheapest_selection_runs(observed_on,snapshot_at) values(p_observed_on,p_snapshot_at);
  get diagnostics inserted=row_count;
  if inserted<>1 then raise exception 'daily selection epoch was not recorded'; end if;
  insert into public.daily_origin_cheapest
    select * from jsonb_populate_recordset(null::public.daily_origin_cheapest,p_rank1);
  insert into public.daily_origin_cheapest_pool
    select * from jsonb_populate_recordset(null::public.daily_origin_cheapest_pool,p_pool);
  return true;
end;
$$;

create or replace function public.collection_commit_roulette(p_owner uuid,p_token bigint,p_ticket jsonb,p_result jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare t public.daily_origin_cheapest_pool; stored public.daily_origin_cheapest_pool; r public.offers; pool_updated integer;
begin
  perform 1 from public.collection_scheduler_state where singleton and owner=p_owner
    and fence=p_token and lease_until>clock_timestamp() for update;
  if not found then raise exception 'collection lease lost'; end if;
  t:=jsonb_populate_record(null::public.daily_origin_cheapest_pool,p_ticket);
  if t.snapshot_at is null or t.origin is null or t.rank is null or t.dest is null
    or t.flight_type is null or t.flight_type not in ('any','direct') or t.departure_at is null or t.return_at is null
    then raise exception 'invalid roulette ticket'; end if;
  select p.* into stored from public.daily_origin_cheapest_pool p
    where p.snapshot_at=t.snapshot_at and p.origin=t.origin and p.flight_type=t.flight_type and p.rank=t.rank
      and p.dest=t.dest and p.departure_at=t.departure_at and p.return_at is not distinct from t.return_at
    for update;
  if not found then raise exception 'roulette target changed before price refresh'; end if;

  -- Empty, error, timeout/429, missing status and legacy replacement payloads are all retention
  -- no-ops. They cannot change price, membership, offers, current epochs or historical epochs.
  if (p_result->>'status') is distinct from 'found' then return true; end if;
  r:=jsonb_populate_record(null::public.offers,p_result);
  if r.price is null or r.price<=0 or r.updated_at is null or r.transfers is null or r.transfers<0
    or (t.flight_type='direct' and r.transfers<>0) then raise exception 'invalid confirmed fare'; end if;

  update public.offers set price=r.price,transfers=r.transfers,airline=r.airline,
    updated_at=r.updated_at,price_source=r.price_source,market=public.aviasales_market_for_origin(t.origin)
    where origin=t.origin and dest=t.dest and month=to_char(t.departure_at,'YYYY-MM')
      and flight_type=t.flight_type and departure_at=t.departure_at and return_at is not distinct from t.return_at;
  update public.daily_origin_cheapest_pool set price=r.price,transfers=r.transfers,
    source_updated_at=r.updated_at,price_source=r.price_source,market=public.aviasales_market_for_origin(t.origin)
    where snapshot_at=t.snapshot_at and origin=t.origin and flight_type=t.flight_type and rank=t.rank
      and dest=t.dest and departure_at=t.departure_at and return_at is not distinct from t.return_at;
  get diagnostics pool_updated=row_count;
  if pool_updated<>1 then raise exception 'roulette target changed before confirmed-price sync'; end if;
  update public.daily_origin_cheapest set price=r.price,transfers=r.transfers,
    source_updated_at=r.updated_at,price_source=r.price_source,market=public.aviasales_market_for_origin(t.origin)
    where snapshot_at=t.snapshot_at and origin=t.origin and flight_type=t.flight_type
      and dest=t.dest and departure_at=t.departure_at and return_at is not distinct from t.return_at;
  return true;
end;
$$;

revoke all on function public.publish_daily_cheapest_selection(date,timestamptz,jsonb,jsonb,boolean) from public,anon,authenticated;
grant execute on function public.publish_daily_cheapest_selection(date,timestamptz,jsonb,jsonb,boolean) to service_role;
revoke all on function public.collection_commit_roulette(uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.collection_commit_roulette(uuid,bigint,jsonb,jsonb) to service_role;
commit;
notify pgrst,'reload schema';
