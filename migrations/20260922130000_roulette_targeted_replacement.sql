-- Confirmed-unavailable roulette candidates are replaced atomically at the same snapshot/rank.
-- Provider/network/429/error results never enter this branch. Requires owner readback of the
-- currently deployed collection_commit_roulette definition before production apply/rollback.
begin;
set local lock_timeout='10s';

create table if not exists public.roulette_pool_replacements(
  event_key text primary key,
  snapshot_at timestamptz not null,
  origin text not null,
  rank smallint not null,
  old_ticket jsonb not null,
  new_ticket jsonb,
  outcome text not null check(outcome in ('replaced','exhausted')),
  reason text not null check(reason='confirmed_no_result'),
  run_id text,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.roulette_pool_replacements enable row level security;
revoke all on public.roulette_pool_replacements from public,anon,authenticated;
grant select,insert on public.roulette_pool_replacements to service_role;

create or replace function public.collection_commit_roulette(p_owner uuid,p_token bigint,p_ticket jsonb,p_result jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare t public.daily_origin_cheapest_pool; r public.offers; candidate public.offers;
  event_id text; allowed text[]; old_json jsonb; new_json jsonb; removed integer;
begin
  perform 1 from public.collection_scheduler_state where singleton and owner=p_owner
    and fence=p_token and lease_until>clock_timestamp() for update;
  if not found then raise exception 'collection lease lost'; end if;
  t:=jsonb_populate_record(null::public.daily_origin_cheapest_pool,p_ticket);
  if t.snapshot_at is null or t.origin is null or t.rank is null or t.dest is null
    or t.departure_at is null or t.return_at is null then raise exception 'invalid roulette ticket'; end if;
  event_id:=concat_ws('|',t.snapshot_at,t.origin,t.flight_type,t.rank,t.dest,t.departure_at,t.return_at);
  if exists(select 1 from public.roulette_pool_replacements where event_key=event_id) then return true; end if;

  if p_result->>'status'='found' then
    r:=jsonb_populate_record(null::public.offers,p_result);
    if r.price is null or r.price<=0 or r.updated_at is null then raise exception 'invalid confirmed fare'; end if;
    update public.offers set price=r.price,transfers=r.transfers,airline=r.airline,
      updated_at=r.updated_at,price_source=r.price_source,market=public.aviasales_market_for_origin(t.origin)
      where origin=t.origin and dest=t.dest and month=to_char(t.departure_at,'YYYY-MM')
        and flight_type=t.flight_type and departure_at=t.departure_at and return_at=t.return_at;
    return true;
  elsif p_result->>'status'<>'no_result' then
    return true;
  end if;

  if jsonb_typeof(p_ticket->'allowed_dests')<>'array' then raise exception 'missing allowed destinations'; end if;
  select array_agg(value order by value) into allowed from jsonb_array_elements_text(p_ticket->'allowed_dests');
  if cardinality(allowed)<1 or cardinality(allowed)>200
    or exists(select 1 from unnest(allowed) d where d!~'^[A-Z]{3}$') then raise exception 'invalid allowed destinations'; end if;
  old_json:=to_jsonb(t);
  select o.* into candidate from public.offers o
    where o.origin=t.origin and o.dest<>t.dest and o.dest=any(allowed)
      and o.departure_at>=(clock_timestamp() at time zone 'Europe/Berlin')::date
      and o.return_at>o.departure_at and o.price>0
      and o.updated_at>=clock_timestamp()-interval '36 hours'
      and not exists(select 1 from public.daily_origin_cheapest_pool p
        where p.snapshot_at=t.snapshot_at and p.origin=t.origin and p.dest=o.dest)
    order by o.price asc,o.updated_at desc,o.transfers asc,o.departure_at asc,o.dest asc,o.flight_type asc
    limit 1;

  delete from public.daily_origin_cheapest_pool p where p.snapshot_at=t.snapshot_at and p.origin=t.origin
    and p.flight_type=t.flight_type and p.rank=t.rank and p.dest=t.dest
    and p.departure_at=t.departure_at and p.return_at=t.return_at;
  get diagnostics removed=row_count;
  if removed<>1 then raise exception 'roulette target changed before replacement'; end if;

  if candidate.origin is not null then
    insert into public.daily_origin_cheapest_pool(observed_on,snapshot_at,origin,market,flight_type,rank,dest,price,currency,
      departure_at,return_at,transfers,source_updated_at,price_source)
      values(t.observed_on,t.snapshot_at,t.origin,candidate.market,candidate.flight_type,t.rank,candidate.dest,candidate.price,'EUR',
        candidate.departure_at,candidate.return_at,candidate.transfers,candidate.updated_at,candidate.price_source);
    new_json:=jsonb_build_object('origin',candidate.origin,'dest',candidate.dest,'flight_type',candidate.flight_type,
      'departure_at',candidate.departure_at,'return_at',candidate.return_at,'price',candidate.price);
  end if;
  delete from public.offers where origin=t.origin and dest=t.dest and month=to_char(t.departure_at,'YYYY-MM')
    and flight_type=t.flight_type and departure_at=t.departure_at and return_at=t.return_at;
  insert into public.roulette_pool_replacements(event_key,snapshot_at,origin,rank,old_ticket,new_ticket,outcome,reason,run_id)
    values(event_id,t.snapshot_at,t.origin,t.rank,old_json,new_json,case when new_json is null then 'exhausted' else 'replaced' end,
      'confirmed_no_result',nullif(p_ticket->>'run_id',''));
  return true;
end;
$$;
revoke all on function public.collection_commit_roulette(uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.collection_commit_roulette(uuid,bigint,jsonb,jsonb) to service_role;
commit;
notify pgrst,'reload schema';
