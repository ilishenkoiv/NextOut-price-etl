-- Owner-manual additive contract: independently publish one origin's factual carousel
-- candidates for one Berlin day. Legacy daily_window_* global epoch remains unchanged.
begin;
set local lock_timeout='10s';

create table if not exists public.daily_origin_window_candidate_runs(
  observed_on date not null,
  origin text not null check(origin~'^[A-Z]{3}$'),
  snapshot_at timestamptz not null,
  contract_version smallint not null default 1 check(contract_version=1),
  candidate_rows integer not null check(candidate_rows>0),
  exact_request_groups integer not null check(exact_request_groups>0),
  completed_at timestamptz not null default clock_timestamp(),
  primary key(observed_on,origin),
  unique(observed_on,origin,snapshot_at)
);

create table if not exists public.daily_origin_window_candidates(
  observed_on date not null,
  origin text not null check(origin~'^[A-Z]{3}$'),
  snapshot_at timestamptz not null,
  market text not null check(market~'^[a-z]{2}$'),
  flight_type text not null check(flight_type in ('direct','any')),
  region_codes text[] not null default '{}'::text[],
  window_kind text not null check(window_kind in ('weekend','holiday')),
  departure_at date not null,
  return_at date not null check(return_at>departure_at),
  position smallint not null check(position>0),
  dest text not null check(dest~'^[A-Z]{3}$'),
  destination_id text not null check(length(btrim(destination_id)) between 1 and 120),
  exact_price numeric(10,2) not null check(exact_price>0),
  currency text not null default 'EUR' check(currency='EUR'),
  transfers smallint check(transfers>=0),
  airline text,
  exact_observed_at timestamptz not null,
  refresh_status text not null check(refresh_status in ('fresh','unavailable','failed')),
  refresh_checked_at timestamptz,
  last_error_kind text,
  price_source jsonb,
  created_at timestamptz not null default clock_timestamp(),
  primary key(snapshot_at,origin,flight_type,departure_at,return_at,position),
  unique(snapshot_at,origin,flight_type,departure_at,return_at,destination_id),
  foreign key(observed_on,origin,snapshot_at)
    references public.daily_origin_window_candidate_runs(observed_on,origin,snapshot_at) on delete cascade,
  check(cardinality(region_codes)<=100)
);
create index if not exists daily_origin_window_candidates_read_idx
  on public.daily_origin_window_candidates(origin,flight_type,observed_on desc,departure_at,return_at,position);

alter table public.daily_origin_window_candidate_runs enable row level security;
alter table public.daily_origin_window_candidates enable row level security;
revoke all on public.daily_origin_window_candidate_runs,public.daily_origin_window_candidates from public,anon,authenticated;
grant select on public.daily_origin_window_candidate_runs,public.daily_origin_window_candidates to anon,authenticated;
grant select,insert,update,delete on public.daily_origin_window_candidate_runs,public.daily_origin_window_candidates to service_role;
drop policy if exists daily_origin_window_candidate_runs_public_read on public.daily_origin_window_candidate_runs;
create policy daily_origin_window_candidate_runs_public_read on public.daily_origin_window_candidate_runs for select to anon,authenticated using(true);
drop policy if exists daily_origin_window_candidates_public_read on public.daily_origin_window_candidates;
create policy daily_origin_window_candidates_public_read on public.daily_origin_window_candidates for select to anon,authenticated using(true);

create or replace function public.publish_daily_origin_window_candidates(
  p_observed_on date,p_snapshot_at timestamptz,p_origin text,p_candidates jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare inserted integer; candidate_count integer; request_groups integer;
begin
  if p_observed_on is null or p_snapshot_at is null or p_origin !~ '^[A-Z]{3}$'
    or jsonb_typeof(p_candidates) is distinct from 'array' or jsonb_array_length(p_candidates)=0 then
    raise exception 'invalid per-origin daily window publication';
  end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) r where
      (r->>'observed_on')::date is distinct from p_observed_on
      or (r->>'snapshot_at')::timestamptz is distinct from p_snapshot_at
      or coalesce((r->>'contract_version')::integer,0)<>1
      or r->>'origin' is distinct from p_origin
      or coalesce(r->>'dest','')!~'^[A-Z]{3}$' or coalesce(r->>'destination_id','')=''
      or coalesce(r->>'flight_type','') not in ('direct','any')
      or coalesce(r->>'window_kind','') not in ('weekend','holiday')
      or (r->>'market') is distinct from public.aviasales_market_for_origin(p_origin)
      or r->>'departure_at' is null or r->>'return_at' is null or r->>'position' is null
      or (r->>'departure_at')::date<p_observed_on+10
      or (r->>'departure_at')::date>(p_observed_on+interval '4 months')::date
      or (r->>'return_at')::date<=(r->>'departure_at')::date
      or coalesce((r->>'exact_price')::numeric,0)<=0 or (r->>'exact_observed_at')::timestamptz is null
      or coalesce(r->>'refresh_status','') not in ('fresh','unavailable','failed')
      or jsonb_typeof(r->'region_codes') is distinct from 'array'
      or jsonb_typeof(r->'price_source') is distinct from 'object') then
    raise exception 'invalid per-origin daily window candidate row';
  end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) r,jsonb_array_elements_text(r->'region_codes') region
      where region is null or region!~'^[A-Z]{2}(-[A-Z0-9]{1,3})?$') then
    raise exception 'invalid per-origin daily window region';
  end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) r
      group by r->>'flight_type',r->>'departure_at',r->>'return_at'
      having min((r->>'position')::integer)<>1 or max((r->>'position')::integer)<>count(*)
        or count(*)<>count(distinct r->>'destination_id')) then
    raise exception 'invalid per-origin candidate ordering';
  end if;
  perform pg_advisory_xact_lock(hashtext('daily-origin-window:'||p_observed_on::text||':'||p_origin));
  -- An old global epoch and a completed origin publication are both immutable compatibility facts.
  -- Neither is replaced, and a legacy all-origin publisher is never called here.
  insert into public.daily_origin_window_candidate_runs(observed_on,origin,snapshot_at,candidate_rows,exact_request_groups)
    select p_observed_on,p_origin,p_snapshot_at,jsonb_array_length(p_candidates),
      count(distinct concat_ws('|',r->>'flight_type',r->>'departure_at',r->>'return_at'))
    from jsonb_array_elements(p_candidates) r on conflict(observed_on,origin) do nothing;
  get diagnostics inserted=row_count;
  if inserted=0 then return false; end if;
  insert into public.daily_origin_window_candidates(observed_on,origin,snapshot_at,market,flight_type,region_codes,window_kind,
    departure_at,return_at,position,dest,destination_id,exact_price,currency,transfers,airline,exact_observed_at,
    refresh_status,refresh_checked_at,last_error_kind,price_source)
  select observed_on,origin,snapshot_at,market,flight_type,region_codes,window_kind,departure_at,return_at,position,dest,
    destination_id,exact_price,currency,transfers,airline,exact_observed_at,refresh_status,refresh_checked_at,last_error_kind,price_source
  from jsonb_populate_recordset(null::public.daily_origin_window_candidates,p_candidates);
  -- Fallback is intentionally narrow: yesterday only, same origin/mode/exact dates only, and
  -- only when this origin has no current factual city for that slot. Its source observation stays intact.
  insert into public.daily_origin_window_candidates(observed_on,origin,snapshot_at,market,flight_type,region_codes,window_kind,
    departure_at,return_at,position,dest,destination_id,exact_price,currency,transfers,airline,exact_observed_at,
    refresh_status,refresh_checked_at,last_error_kind,price_source)
  select p_observed_on,p_origin,p_snapshot_at,old.market,old.flight_type,old.region_codes,old.window_kind,
    old.departure_at,old.return_at,old.position,old.dest,old.destination_id,old.exact_price,old.currency,old.transfers,old.airline,
    old.exact_observed_at,'failed',clock_timestamp(),'carried_forward_missing_fresh_selection',
    jsonb_set(coalesce(old.price_source,'{}'::jsonb),'{carousel_fallback}',jsonb_build_object(
      'kind','previous_day_same_origin_mode_dates','source_observed_on',old.observed_on,'source_snapshot_at',old.snapshot_at,
      'carried_at',p_snapshot_at,'fresh',false),true)
  from public.daily_origin_window_candidates old
  where old.observed_on=p_observed_on-1 and old.origin=p_origin
    and not exists(select 1 from public.daily_origin_window_candidates current
      where current.snapshot_at=p_snapshot_at and current.origin=p_origin
        and current.flight_type=old.flight_type and current.departure_at=old.departure_at and current.return_at=old.return_at);
  select count(*),count(distinct concat_ws('|',flight_type,departure_at,return_at)) into candidate_count,request_groups
    from public.daily_origin_window_candidates where observed_on=p_observed_on and origin=p_origin and snapshot_at=p_snapshot_at;
  if candidate_count<jsonb_array_length(p_candidates) or request_groups<1 then
    raise exception 'incomplete per-origin daily window publication';
  end if;
  update public.daily_origin_window_candidate_runs set candidate_rows=candidate_count,exact_request_groups=request_groups
    where observed_on=p_observed_on and origin=p_origin;
  return true;
end;
$$;

revoke all on function public.publish_daily_origin_window_candidates(date,timestamptz,text,jsonb) from public,anon,authenticated;
grant execute on function public.publish_daily_origin_window_candidates(date,timestamptz,text,jsonb) to service_role;
commit;
notify pgrst,'reload schema';
