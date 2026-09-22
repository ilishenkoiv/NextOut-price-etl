-- Shared, non-personal daily weekend/holiday candidate epoch (contract v1).
-- Membership/order is published once per Berlin day; refresh mutates observation fields only.
begin;
set local lock_timeout='10s';

create table if not exists public.daily_window_candidate_epochs(
  observed_on date primary key,
  snapshot_at timestamptz not null unique,
  contract_version smallint not null check(contract_version=1),
  candidate_rows integer not null check(candidate_rows>0),
  exact_request_groups integer not null check(exact_request_groups>0),
  completed_at timestamptz not null default clock_timestamp(),
  unique(observed_on,snapshot_at)
);

create table if not exists public.daily_window_candidates(
  observed_on date not null,
  snapshot_at timestamptz not null,
  origin text not null check(origin~'^[A-Z]{3}$'),
  market text not null check(market~'^[a-z]{2}$'),
  flight_type text not null check(flight_type in ('direct','any')),
  region_codes text[] not null default '{}'::text[],
  window_kind text not null check(window_kind in ('weekend','holiday')),
  departure_at date not null,
  return_at date not null check(return_at>departure_at),
  position smallint not null check(position>0),
  dest text not null check(dest~'^[A-Z]{3}$'),
  destination_id text not null check(length(btrim(destination_id)) between 1 and 120),
  exact_price numeric(10,2) check(exact_price>0),
  currency text not null default 'EUR' check(currency='EUR'),
  transfers smallint check(transfers>=0),
  airline text,
  exact_observed_at timestamptz,
  refresh_status text not null check(refresh_status in ('fresh','unavailable','failed')),
  refresh_checked_at timestamptz,
  last_error_kind text,
  price_source jsonb,
  created_at timestamptz not null default clock_timestamp(),
  primary key(snapshot_at,origin,flight_type,departure_at,return_at,position),
  unique(snapshot_at,origin,flight_type,departure_at,return_at,destination_id),
  foreign key(observed_on,snapshot_at) references public.daily_window_candidate_epochs(observed_on,snapshot_at) on delete cascade,
  check(cardinality(region_codes)<=100),
  check(refresh_status<>'fresh' or (exact_price is not null and exact_observed_at is not null))
);

create index if not exists daily_window_candidates_read_idx
  on public.daily_window_candidates(origin,flight_type,snapshot_at desc,departure_at,return_at,position);
create index if not exists daily_window_candidates_retention_idx on public.daily_window_candidates(snapshot_at);

alter table public.daily_window_candidate_epochs enable row level security;
alter table public.daily_window_candidates enable row level security;
revoke all on public.daily_window_candidate_epochs,public.daily_window_candidates from public,anon,authenticated;
grant select on public.daily_window_candidate_epochs,public.daily_window_candidates to anon,authenticated;
grant select,insert,update,delete on public.daily_window_candidate_epochs,public.daily_window_candidates to service_role;
drop policy if exists daily_window_candidate_epochs_public_read on public.daily_window_candidate_epochs;
create policy daily_window_candidate_epochs_public_read on public.daily_window_candidate_epochs for select to anon,authenticated using(true);
drop policy if exists daily_window_candidates_public_read on public.daily_window_candidates;
create policy daily_window_candidates_public_read on public.daily_window_candidates for select to anon,authenticated using(true);

create or replace function public.publish_daily_window_candidates(p_observed_on date,p_snapshot_at timestamptz,p_candidates jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare inserted integer; candidate_count integer; request_groups integer;
begin
  if p_observed_on is null or p_snapshot_at is null or jsonb_typeof(p_candidates) is distinct from 'array'
    or jsonb_array_length(p_candidates)=0 then raise exception 'invalid daily window candidate epoch'; end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) r where
      (r->>'observed_on')::date is distinct from p_observed_on
      or (r->>'snapshot_at')::timestamptz is distinct from p_snapshot_at
      or coalesce((r->>'contract_version')::integer,0)<>1
      or coalesce(r->>'origin','')!~'^[A-Z]{3}$' or coalesce(r->>'dest','')!~'^[A-Z]{3}$'
      or coalesce(r->>'destination_id','')=''
      or coalesce(r->>'flight_type','') not in ('direct','any')
      or coalesce(r->>'window_kind','') not in ('weekend','holiday')
      or (r->>'market') is distinct from public.aviasales_market_for_origin(r->>'origin')
      or r->>'departure_at' is null or r->>'return_at' is null or r->>'position' is null
      or (r->>'departure_at')::date<p_observed_on+10
      or (r->>'departure_at')::date>(p_observed_on+interval '4 months')::date
      or (r->>'return_at')::date<=(r->>'departure_at')::date
      or coalesce((r->>'exact_price')::numeric,0)<=0
      or (r->>'exact_observed_at')::timestamptz is null
      or r->>'refresh_status'<>'fresh'
      or jsonb_typeof(r->'region_codes') is distinct from 'array')
    then raise exception 'invalid daily window candidate row'; end if;
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
  get diagnostics candidate_count=row_count;
  select count(distinct concat_ws('|',origin,dest,departure_at,return_at)) into request_groups
    from public.daily_window_candidates where snapshot_at=p_snapshot_at;
  if candidate_count<>jsonb_array_length(p_candidates) or request_groups<1 then raise exception 'incomplete daily window publication';end if;
  if exists(select 1 from public.daily_window_candidates where snapshot_at=p_snapshot_at
      group by origin,flight_type,departure_at,return_at
      having min(position)<>1 or max(position)<>count(*) or count(*)<>count(distinct destination_id))
    then raise exception 'invalid candidate ordering';end if;
  update public.daily_window_candidate_epochs set candidate_rows=candidate_count,exact_request_groups=request_groups
    where observed_on=p_observed_on;
  delete from public.daily_window_candidate_epochs where snapshot_at<clock_timestamp()-interval '31 days';
  return true;
end;
$$;

create or replace function public.collection_commit_window_candidate(p_owner uuid,p_token bigint,p_ticket jsonb,p_result jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare t public.daily_window_candidates; status text; observed timestamptz; checked timestamptz;
begin
  perform 1 from public.collection_scheduler_state where singleton and owner=p_owner and fence=p_token
    and lease_until>clock_timestamp() for update;
  if not found then raise exception 'collection lease lost';end if;
  t:=jsonb_populate_record(null::public.daily_window_candidates,p_ticket);status:=p_result->>'status';
  if t.snapshot_at is null or t.origin is null or t.flight_type is null or t.departure_at is null or t.return_at is null
    or t.position is null or t.destination_id is null then raise exception 'invalid window candidate ticket';end if;
  perform 1 from public.daily_window_candidates c where c.snapshot_at=t.snapshot_at and c.origin=t.origin
    and c.flight_type=t.flight_type and c.departure_at=t.departure_at and c.return_at=t.return_at
    and c.position=t.position and c.destination_id=t.destination_id for update;
  if not found then raise exception 'window candidate changed';end if;
  if status='found' then
    observed:=(p_result->>'updated_at')::timestamptz;checked:=coalesce((p_result->>'checked_at')::timestamptz,observed);
    if coalesce((p_result->>'price')::numeric,0)<=0 or observed is null
      or (t.flight_type='direct' and coalesce((p_result->>'transfers')::smallint,-1)<>0)
      then raise exception 'invalid confirmed window fare';end if;
    insert into public.window_prices(origin,market,dest,flight_type,departure_at,return_at,nights,price,transfers,airline,updated_at,price_source,window_kind)
      values(t.origin,t.market,t.dest,t.flight_type,t.departure_at,t.return_at,(t.return_at-t.departure_at)::smallint,
        (p_result->>'price')::numeric,(p_result->>'transfers')::smallint,nullif(p_result->>'airline',''),observed,p_result->'price_source',t.window_kind)
      on conflict(origin,dest,flight_type,departure_at,return_at) do update set market=excluded.market,nights=excluded.nights,
        price=excluded.price,transfers=excluded.transfers,airline=excluded.airline,updated_at=excluded.updated_at,
        price_source=excluded.price_source,window_kind=excluded.window_kind;
    delete from public.window_price_misses where origin=t.origin and dest=t.dest and flight_type=t.flight_type
      and departure_at=t.departure_at and return_at=t.return_at;
    update public.daily_window_candidates set exact_price=(p_result->>'price')::numeric,
      transfers=(p_result->>'transfers')::smallint,airline=nullif(p_result->>'airline',''),
      exact_observed_at=observed,refresh_checked_at=checked,refresh_status='fresh',last_error_kind=null,
      price_source=p_result->'price_source'
      where snapshot_at=t.snapshot_at and origin=t.origin and flight_type=t.flight_type and departure_at=t.departure_at
        and return_at=t.return_at and position=t.position;
  elsif status='no_result' then
    insert into public.window_price_misses(origin,market,dest,flight_type,departure_at,return_at,window_kind,outcome,detail,checked_at)
      values(t.origin,t.market,t.dest,t.flight_type,t.departure_at,t.return_at,t.window_kind,'empty',p_result->>'detail',clock_timestamp())
      on conflict(origin,dest,flight_type,departure_at,return_at) do update set market=excluded.market,window_kind=excluded.window_kind,
        outcome=excluded.outcome,detail=excluded.detail,checked_at=excluded.checked_at;
    update public.daily_window_candidates set refresh_status='unavailable',refresh_checked_at=clock_timestamp(),last_error_kind=null
      where snapshot_at=t.snapshot_at and origin=t.origin and flight_type=t.flight_type and departure_at=t.departure_at
        and return_at=t.return_at and position=t.position;
  elsif status='error' then
    insert into public.window_price_misses(origin,market,dest,flight_type,departure_at,return_at,window_kind,outcome,detail,checked_at)
      values(t.origin,t.market,t.dest,t.flight_type,t.departure_at,t.return_at,t.window_kind,'http_error',left(coalesce(p_result->>'detail','technical_error'),120),clock_timestamp())
      on conflict(origin,dest,flight_type,departure_at,return_at) do update set market=excluded.market,window_kind=excluded.window_kind,
        outcome=excluded.outcome,detail=excluded.detail,checked_at=excluded.checked_at;
    update public.daily_window_candidates set refresh_status='failed',refresh_checked_at=clock_timestamp(),
      last_error_kind=left(coalesce(p_result->>'detail','technical_error'),120)
      where snapshot_at=t.snapshot_at and origin=t.origin and flight_type=t.flight_type and departure_at=t.departure_at
        and return_at=t.return_at and position=t.position;
  else
    return true;
  end if;
  return true;
end;
$$;

revoke all on function public.publish_daily_window_candidates(date,timestamptz,jsonb) from public,anon,authenticated;
revoke all on function public.collection_commit_window_candidate(uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.publish_daily_window_candidates(date,timestamptz,jsonb) to service_role;
grant execute on function public.collection_commit_window_candidate(uuid,bigint,jsonb,jsonb) to service_role;
commit;
notify pgrst,'reload schema';
