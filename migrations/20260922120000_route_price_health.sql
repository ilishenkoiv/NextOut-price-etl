-- Durable route-level no-price evidence. APPLY MANUALLY before the coordinator code that calls
-- collection_record_route_observation. This migration is idempotent and does not delete catalogue
-- routes or historical prices/offers.
--
-- Readback:
--   select status,count(*) from public.route_price_health group by status order by status;
--   select proname from pg_proc where proname='collection_record_route_observation';
-- Rollback (code must be rolled back first):
--   drop function if exists public.collection_record_route_observation(uuid,bigint,bigint,text,text,text,text[],boolean,boolean);
--   drop function if exists public.collection_revive_route(uuid,bigint,text,text,timestamptz);
--   alter table public.route_price_health rename to route_price_health_rollback_20260922;
begin;

create table if not exists public.route_price_health (
  origin text not null,
  dest text not null,
  status text not null default 'active' check (status in ('active','dead')),
  first_observed_at timestamptz not null default clock_timestamp(),
  protected_until timestamptz,
  first_confirmed_no_price_at timestamptz,
  last_confirmed_no_price_at timestamptz,
  last_price_at timestamptz,
  observation_pass bigint,
  observation_horizon text[] not null default '{}',
  observed_months text[] not null default '{}',
  pass_has_price boolean not null default false,
  updated_at timestamptz not null default clock_timestamp(),
  primary key(origin,dest),
  check (origin <> dest)
);
alter table public.route_price_health add column if not exists observation_horizon text[] not null default '{}';
create index if not exists route_price_health_status_idx on public.route_price_health(status,updated_at,origin,dest);
alter table public.route_price_health enable row level security;
revoke all on table public.route_price_health from public,anon,authenticated;
grant select,insert,update on table public.route_price_health to service_role;

create or replace function public.collection_record_route_observation(
  p_owner uuid,p_token bigint,p_pass_id bigint,p_origin text,p_dest text,p_month text,
  p_horizon text[],p_has_price boolean,p_is_expansion boolean default false
) returns boolean language plpgsql security definer set search_path=public as $$
declare h public.route_price_health; now_at timestamptz:=clock_timestamp();
begin
  perform 1 from public.collection_scheduler_state where singleton and owner=p_owner
    and fence=p_token and lease_until>now_at for update;
  if not found then raise exception 'collection lease lost'; end if;
  if p_origin is null or p_dest is null or p_origin=p_dest or p_month !~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'
    or cardinality(p_horizon)<>6 or p_has_price is null or not(p_month=any(p_horizon))
    or exists(select 1 from unnest(p_horizon) m where m!~'^20[0-9]{2}-(0[1-9]|1[0-2])$')
    or (select count(distinct m) from unnest(p_horizon) m)<>6 then raise exception 'invalid route observation'; end if;

  insert into public.route_price_health(origin,dest,protected_until,observation_pass,observation_horizon,observed_months,pass_has_price)
    values(p_origin,p_dest,case when p_is_expansion then now_at+interval '30 days' end,p_pass_id,p_horizon,array[p_month],p_has_price)
    on conflict(origin,dest) do nothing;
  select * into h from public.route_price_health where origin=p_origin and dest=p_dest for update;

  if h.observation_pass is not null and p_pass_id<h.observation_pass then raise exception 'stale route observation pass'; end if;
  if h.observation_pass is distinct from p_pass_id then
    h.observation_pass:=p_pass_id;h.observation_horizon:=p_horizon;h.observed_months:='{}';h.pass_has_price:=false;
  elsif h.observation_horizon is distinct from p_horizon then
    raise exception 'route observation horizon changed within pass';
  end if;
  if not (p_month=any(h.observed_months)) then h.observed_months:=array_append(h.observed_months,p_month); end if;
  h.pass_has_price:=h.pass_has_price or p_has_price;
  if p_is_expansion and h.protected_until is null then h.protected_until:=h.first_observed_at+interval '30 days'; end if;

  -- Any confirmed price revives immediately, even before the six-month pass completes.
  if p_has_price then
    h.status:='active';h.first_confirmed_no_price_at:=null;h.last_price_at:=now_at;
  elsif cardinality(h.observed_months)=6 then
    if h.pass_has_price then
      h.status:='active';h.first_confirmed_no_price_at:=null;
    else
      h.first_confirmed_no_price_at:=coalesce(h.first_confirmed_no_price_at,now_at);
      h.last_confirmed_no_price_at:=now_at;
      if h.first_confirmed_no_price_at<=now_at-interval '30 days'
        and now_at>=coalesce(h.protected_until,h.first_observed_at) then h.status:='dead'; end if;
    end if;
  end if;
  h.updated_at:=now_at;
  update public.route_price_health set status=h.status,first_observed_at=h.first_observed_at,
    protected_until=h.protected_until,first_confirmed_no_price_at=h.first_confirmed_no_price_at,
    last_confirmed_no_price_at=h.last_confirmed_no_price_at,last_price_at=h.last_price_at,
    observation_pass=h.observation_pass,observation_horizon=h.observation_horizon,
    observed_months=h.observed_months,pass_has_price=h.pass_has_price,updated_at=h.updated_at
    where origin=p_origin and dest=p_dest;
  return true;
end;
$$;
revoke all on function public.collection_record_route_observation(uuid,bigint,bigint,text,text,text,text[],boolean,boolean) from public,anon,authenticated;
grant execute on function public.collection_record_route_observation(uuid,bigint,bigint,text,text,text,text[],boolean,boolean) to service_role;

create or replace function public.collection_revive_route(p_owner uuid,p_token bigint,p_origin text,p_dest text,p_observed_at timestamptz)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  perform 1 from public.collection_scheduler_state where singleton and owner=p_owner
    and fence=p_token and lease_until>clock_timestamp() for update;
  if not found then raise exception 'collection lease lost'; end if;
  if p_origin is null or p_dest is null or p_origin=p_dest or p_observed_at is null then raise exception 'invalid route revival'; end if;
  insert into public.route_price_health(origin,dest,status,last_price_at,updated_at)
    values(p_origin,p_dest,'active',p_observed_at,p_observed_at)
    on conflict(origin,dest) do update set status='active',first_confirmed_no_price_at=null,
      last_price_at=greatest(public.route_price_health.last_price_at,excluded.last_price_at),updated_at=excluded.updated_at;
  return true;
end;
$$;
revoke all on function public.collection_revive_route(uuid,bigint,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.collection_revive_route(uuid,bigint,text,text,timestamptz) to service_role;

commit;
notify pgrst, 'reload schema';
