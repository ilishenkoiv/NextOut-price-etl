-- Temporary immediate-dead policy through 2026-09-29 00:00 Europe/Berlin, then permanent
-- seven-day eligibility. Complete six-month evidence remains mandatory; errors are never empty.
begin;
set local lock_timeout='10s';

alter table public.route_price_health add column if not exists dead_policy text;
alter table public.route_price_health add column if not exists temporary_dead_until timestamptz;
alter table public.route_price_health drop constraint if exists route_price_health_dead_policy_check;
alter table public.route_price_health add constraint route_price_health_dead_policy_check
  check(dead_policy is null or dead_policy in ('temporary_immediate','permanent_7d'));
update public.route_price_health set dead_policy='permanent_7d'
  where status='dead' and dead_policy is null;

create or replace function public.collection_record_route_observation(
  p_owner uuid,p_token bigint,p_pass_id bigint,p_origin text,p_dest text,p_month text,
  p_horizon text[],p_has_price boolean,p_is_expansion boolean default false
) returns boolean language plpgsql security definer set search_path=public as $$
declare
  h public.route_price_health;
  now_at timestamptz:=clock_timestamp();
  temporary_cutoff constant timestamptz:='2026-09-28 22:00:00+00';
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
  -- Temporary classification expires automatically on the first later observation. If the route
  -- is not independently seven-day eligible (and outside expansion protection), it becomes active.
  if h.status='dead' and h.dead_policy='temporary_immediate'
      and now_at>=coalesce(h.temporary_dead_until,temporary_cutoff) then
    if h.first_confirmed_no_price_at<=now_at-interval '7 days'
        and now_at>=coalesce(h.protected_until,h.first_observed_at) then
      h.status:='dead';h.dead_policy:='permanent_7d';
    else h.status:='active';h.dead_policy:=null;end if;
    h.temporary_dead_until:=null;
  end if;
  if h.observation_pass is distinct from p_pass_id then
    h.observation_pass:=p_pass_id;h.observation_horizon:=p_horizon;h.observed_months:='{}';h.pass_has_price:=false;
  elsif h.observation_horizon is distinct from p_horizon then
    raise exception 'route observation horizon changed within pass';
  end if;
  if not (p_month=any(h.observed_months)) then h.observed_months:=array_append(h.observed_months,p_month); end if;
  h.pass_has_price:=h.pass_has_price or p_has_price;
  if p_is_expansion and h.protected_until is null then h.protected_until:=h.first_observed_at+interval '30 days'; end if;

  if p_has_price then
    h.status:='active';h.dead_policy:=null;h.temporary_dead_until:=null;
    h.first_confirmed_no_price_at:=null;h.last_price_at:=now_at;
  elsif cardinality(h.observed_months)=6 then
    if h.pass_has_price then
      h.status:='active';h.dead_policy:=null;h.temporary_dead_until:=null;h.first_confirmed_no_price_at:=null;
    else
      h.first_confirmed_no_price_at:=coalesce(h.first_confirmed_no_price_at,now_at);
      h.last_confirmed_no_price_at:=now_at;
      if now_at<temporary_cutoff then
        -- Explicit temporary exception: complete confirmed-empty evidence may suppress expansion
        -- routes immediately, but only until the fixed cutoff.
        h.status:='dead';h.dead_policy:='temporary_immediate';h.temporary_dead_until:=temporary_cutoff;
      elsif h.first_confirmed_no_price_at<=now_at-interval '7 days'
          and now_at>=coalesce(h.protected_until,h.first_observed_at) then
        h.status:='dead';h.dead_policy:='permanent_7d';h.temporary_dead_until:=null;
      else
        h.status:='active';h.dead_policy:=null;h.temporary_dead_until:=null;
      end if;
    end if;
  end if;
  h.updated_at:=now_at;
  update public.route_price_health set status=h.status,dead_policy=h.dead_policy,temporary_dead_until=h.temporary_dead_until,
    first_observed_at=h.first_observed_at,protected_until=h.protected_until,
    first_confirmed_no_price_at=h.first_confirmed_no_price_at,last_confirmed_no_price_at=h.last_confirmed_no_price_at,
    last_price_at=h.last_price_at,observation_pass=h.observation_pass,observation_horizon=h.observation_horizon,
    observed_months=h.observed_months,pass_has_price=h.pass_has_price,updated_at=h.updated_at
    where origin=p_origin and dest=p_dest;
  return true;
end;
$$;

create or replace function public.collection_revive_route(p_owner uuid,p_token bigint,p_origin text,p_dest text,p_observed_at timestamptz)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  perform 1 from public.collection_scheduler_state where singleton and owner=p_owner
    and fence=p_token and lease_until>clock_timestamp() for update;
  if not found then raise exception 'collection lease lost'; end if;
  if p_origin is null or p_dest is null or p_origin=p_dest or p_observed_at is null then raise exception 'invalid route revival'; end if;
  insert into public.route_price_health(origin,dest,status,dead_policy,temporary_dead_until,last_price_at,updated_at)
    values(p_origin,p_dest,'active',null,null,p_observed_at,p_observed_at)
    on conflict(origin,dest) do update set status='active',dead_policy=null,temporary_dead_until=null,
      first_confirmed_no_price_at=null,last_price_at=greatest(public.route_price_health.last_price_at,excluded.last_price_at),
      updated_at=excluded.updated_at;
  return true;
end;
$$;

revoke all on function public.collection_record_route_observation(uuid,bigint,bigint,text,text,text,text[],boolean,boolean) from public,anon,authenticated;
revoke all on function public.collection_revive_route(uuid,bigint,text,text,timestamptz) from public,anon,authenticated;
grant execute on function public.collection_record_route_observation(uuid,bigint,bigint,text,text,text,text[],boolean,boolean) to service_role;
grant execute on function public.collection_revive_route(uuid,bigint,text,text,timestamptz) to service_role;
commit;
notify pgrst,'reload schema';
