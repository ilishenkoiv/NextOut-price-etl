-- Owner-approved 2026-11-02 contract:
-- publish each complete roulette origin independently; carry a missing carousel slot only
-- from yesterday's identical origin/mode/date slot, retaining its original observation.
begin;
set local lock_timeout='10s';

create table if not exists public.daily_cheapest_origin_selection_runs(
  observed_on date not null,
  origin text not null check(origin~'^[A-Z]{3}$'),
  snapshot_at timestamptz not null,
  completed_at timestamptz not null default clock_timestamp(),
  primary key(observed_on,origin)
);
alter table public.daily_cheapest_origin_selection_runs enable row level security;
revoke all on public.daily_cheapest_origin_selection_runs from public,anon,authenticated;
grant select,insert,update,delete on public.daily_cheapest_origin_selection_runs to service_role;

create or replace function public.publish_daily_cheapest_origin_selection(
  p_observed_on date,p_snapshot_at timestamptz,p_origin text,p_rank1 jsonb,p_pool jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare inserted integer;
begin
  if p_observed_on is null or p_snapshot_at is null or p_origin !~ '^[A-Z]{3}$'
    or jsonb_typeof(p_rank1)<>'array' or jsonb_array_length(p_rank1)=0
    or jsonb_typeof(p_pool)<>'array' or jsonb_array_length(p_pool)<>10 then
    raise exception 'invalid per-origin daily selection';
  end if;
  if exists(select 1 from jsonb_array_elements(p_rank1) r where
      (r->>'observed_on')::date is distinct from p_observed_on
      or (r->>'snapshot_at')::timestamptz is distinct from p_snapshot_at
      or r->>'origin' is distinct from p_origin
      or coalesce((r->>'price')::numeric,0)<=0)
    or exists(select 1 from jsonb_array_elements(p_pool) r where
      (r->>'observed_on')::date is distinct from p_observed_on
      or (r->>'snapshot_at')::timestamptz is distinct from p_snapshot_at
      or r->>'origin' is distinct from p_origin
      or coalesce((r->>'price')::numeric,0)<=0
      or coalesce(r->>'dest','')!~'^[A-Z]{3}$'
      or coalesce(r->>'flight_type','') not in ('any','direct')
      or coalesce((r->>'rank')::integer,0) not between 1 and 10) then
    raise exception 'invalid per-origin daily selection';
  end if;
  if exists(select 1 from jsonb_array_elements(p_pool) r where not exists(
      select 1 from jsonb_array_elements(p_rank1) q where q->>'origin'=r->>'origin')) then
    raise exception 'daily roulette origin missing rank-1 compatibility row';
  end if;
  if (select count(*) from jsonb_array_elements(p_pool))<>10
    or (select count(distinct (r->>'rank')::integer) from jsonb_array_elements(p_pool) r)<>10
    or (select min((r->>'rank')::integer) from jsonb_array_elements(p_pool) r)<>1
    or (select max((r->>'rank')::integer) from jsonb_array_elements(p_pool) r)<>10
    or (select count(distinct r->>'dest') from jsonb_array_elements(p_pool) r)<>10 then
    raise exception 'daily roulette origin must contain ten unique cities ranked 1-10';
  end if;
  perform pg_advisory_xact_lock(hashtext('daily-cheapest-origin:'||p_observed_on::text||':'||p_origin));
  -- A successful legacy all-origin epoch remains immutable and is never mixed with a new origin epoch.
  if exists(select 1 from public.daily_cheapest_selection_runs where observed_on=p_observed_on) then return false; end if;
  insert into public.daily_cheapest_origin_selection_runs(observed_on,origin,snapshot_at)
    values(p_observed_on,p_origin,p_snapshot_at) on conflict(observed_on,origin) do nothing;
  get diagnostics inserted=row_count;
  if inserted=0 then return false; end if;
  if exists(select 1 from public.daily_origin_cheapest_pool where observed_on=p_observed_on and origin=p_origin)
    or exists(select 1 from public.daily_origin_cheapest where observed_on=p_observed_on and origin=p_origin) then
    raise exception 'pre-existing daily selection without per-origin marker';
  end if;
  insert into public.daily_origin_cheapest select * from jsonb_populate_recordset(null::public.daily_origin_cheapest,p_rank1);
  insert into public.daily_origin_cheapest_pool select * from jsonb_populate_recordset(null::public.daily_origin_cheapest_pool,p_pool);
  -- Retention is intentionally not performed here. This RPC publishes one origin, so an
  -- age-only cleanup could delete a retained incomplete origin (for example FRA) while
  -- publishing MUC. The established dedicated retention path owns global cleanup.
  return true;
end;
$$;

-- The existing client contract already understands non-fresh window candidates.  Reuse
-- 'failed' (rather than inventing a client status) and expose explicit provenance in price_source.
create or replace function public.publish_daily_window_candidates(p_observed_on date,p_snapshot_at timestamptz,p_candidates jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare inserted integer; candidate_count integer; request_groups integer;
begin
  if p_observed_on is null or p_snapshot_at is null or jsonb_typeof(p_candidates) is distinct from 'array'
    or jsonb_array_length(p_candidates)=0 then raise exception 'invalid daily window candidate epoch'; end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) r where
      (r->>'observed_on')::date is distinct from p_observed_on or (r->>'snapshot_at')::timestamptz is distinct from p_snapshot_at
      or coalesce((r->>'contract_version')::integer,0)<>1 or coalesce(r->>'origin','')!~'^[A-Z]{3}$'
      or coalesce(r->>'dest','')!~'^[A-Z]{3}$' or coalesce(r->>'destination_id','')=''
      or coalesce(r->>'flight_type','') not in ('direct','any') or coalesce(r->>'window_kind','') not in ('weekend','holiday')
      or (r->>'market') is distinct from public.aviasales_market_for_origin(r->>'origin')
      or r->>'departure_at' is null or r->>'return_at' is null or r->>'position' is null
      or (r->>'departure_at')::date<p_observed_on+10 or (r->>'departure_at')::date>(p_observed_on+interval '4 months')::date
      or (r->>'return_at')::date<=(r->>'departure_at')::date or coalesce((r->>'exact_price')::numeric,0)<=0
      or (r->>'exact_observed_at')::timestamptz is null or coalesce(r->>'refresh_status','') not in ('fresh','unavailable','failed')
      or jsonb_typeof(r->'region_codes') is distinct from 'array') then raise exception 'invalid daily window candidate row'; end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) r,jsonb_array_elements_text(r->'region_codes') region
      where region is null or region!~'^[A-Z]{2}(-[A-Z0-9]{1,3})?$') then raise exception 'invalid daily window region'; end if;
  perform pg_advisory_xact_lock(hashtext('daily-window-candidates:'||p_observed_on::text));
  insert into public.daily_window_candidate_epochs(observed_on,snapshot_at,contract_version,candidate_rows,exact_request_groups)
    select p_observed_on,p_snapshot_at,1,jsonb_array_length(p_candidates),count(distinct concat_ws('|',r->>'origin',r->>'dest',r->>'departure_at',r->>'return_at'))
    from jsonb_array_elements(p_candidates) r on conflict(observed_on) do nothing;
  get diagnostics inserted=row_count;if inserted=0 then return false;end if;
  insert into public.daily_window_candidates(observed_on,snapshot_at,origin,market,flight_type,region_codes,window_kind,
    departure_at,return_at,position,dest,destination_id,exact_price,currency,transfers,airline,exact_observed_at,
    refresh_status,refresh_checked_at,last_error_kind,price_source)
  select observed_on,snapshot_at,origin,market,flight_type,region_codes,window_kind,departure_at,return_at,position,dest,
    destination_id,exact_price,currency,transfers,airline,exact_observed_at,refresh_status,refresh_checked_at,last_error_kind,price_source
  from jsonb_populate_recordset(null::public.daily_window_candidates,p_candidates);
  -- Only an absent identical slide slot may carry forward. Origin, mode, departure and return
  -- are copied unchanged; the original exact_observed_at is retained and provenance says stale.
  insert into public.daily_window_candidates(observed_on,snapshot_at,origin,market,flight_type,region_codes,window_kind,
    departure_at,return_at,position,dest,destination_id,exact_price,currency,transfers,airline,exact_observed_at,
    refresh_status,refresh_checked_at,last_error_kind,price_source)
  select p_observed_on,p_snapshot_at,old.origin,old.market,old.flight_type,old.region_codes,old.window_kind,
    old.departure_at,old.return_at,old.position,old.dest,old.destination_id,old.exact_price,old.currency,old.transfers,old.airline,
    old.exact_observed_at,'failed',clock_timestamp(),'carried_forward_missing_fresh_selection',
    jsonb_set(coalesce(old.price_source,'{}'::jsonb),'{carousel_fallback}',jsonb_build_object(
      'kind','previous_day_same_slide','source_observed_on',old.observed_on,'source_snapshot_at',old.snapshot_at,
      'carried_at',p_snapshot_at,'fresh',false),true)
  from public.daily_window_candidates old
  where old.observed_on=p_observed_on-1
    and not exists(select 1 from public.daily_window_candidates current where current.snapshot_at=p_snapshot_at
      and current.origin=old.origin and current.flight_type=old.flight_type
      and current.departure_at=old.departure_at and current.return_at=old.return_at);
  get diagnostics candidate_count=row_count;
  select count(*) into candidate_count from public.daily_window_candidates where snapshot_at=p_snapshot_at;
  select count(distinct concat_ws('|',origin,dest,departure_at,return_at)) into request_groups from public.daily_window_candidates where snapshot_at=p_snapshot_at;
  if candidate_count<jsonb_array_length(p_candidates) or request_groups<1 then raise exception 'incomplete daily window publication';end if;
  if exists(select 1 from public.daily_window_candidates where snapshot_at=p_snapshot_at group by origin,flight_type,departure_at,return_at
      having min(position)<>1 or max(position)<>count(*) or count(*)<>count(distinct destination_id)) then raise exception 'invalid candidate ordering';end if;
  update public.daily_window_candidate_epochs set candidate_rows=candidate_count,exact_request_groups=request_groups where observed_on=p_observed_on;
  delete from public.daily_window_candidate_epochs where snapshot_at<clock_timestamp()-interval '31 days';
  return true;
end;
$$;

revoke all on function public.publish_daily_cheapest_origin_selection(date,timestamptz,text,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.publish_daily_cheapest_origin_selection(date,timestamptz,text,jsonb,jsonb) to service_role;
revoke all on function public.publish_daily_window_candidates(date,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.publish_daily_window_candidates(date,timestamptz,jsonb) to service_role;
commit;
notify pgrst,'reload schema';
