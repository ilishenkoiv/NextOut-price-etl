-- Owner-applied SQL. Existing schemas/data are preserved. Each collection unit
-- checks the fencing token and commits related prices/history/offers atomically.
begin;
-- A retry uses the same snapshot timestamp/PK rather than adding another pool.
grant update on public.daily_origin_cheapest_pool to service_role;
create or replace function public.collection_commit_main(p_owner uuid,p_token bigint,p_price jsonb,p_offers jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare p public.prices; old_price public.prices;
begin
  perform 1 from public.collection_scheduler_state where singleton and owner=p_owner
    and fence=p_token and lease_until>clock_timestamp() for update;
  if not found then raise exception 'collection lease lost'; end if;
  p := jsonb_populate_record(null::public.prices,p_price);
  if p.origin is null or p.dest is null or p.origin=p.dest or p.month is null
    or p.market is distinct from public.aviasales_market_for_origin(p.origin)
    or p.updated_at is null or jsonb_typeof(p_offers) is distinct from 'array' then raise exception 'invalid cell'; end if;
  if exists(select 1 from jsonb_array_elements(p_offers) o where
    o->>'origin' is distinct from p.origin or o->>'dest' is distinct from p.dest
    or o->>'month' is distinct from p.month or o->>'market' is distinct from p.market) then raise exception 'mixed cell'; end if;
  select * into old_price from public.prices where origin=p.origin and dest=p.dest and month=p.month;
  if (p.direct is not null or p.any_stops is not null) and
    (old_price.origin is null or (old_price.direct,old_price.any_stops) is distinct from (p.direct,p.any_stops)) then
    insert into public.price_history(origin,market,dest,month,direct,any_stops)
      values(p.origin,p.market,p.dest,p.month,p.direct,p.any_stops);
  end if;
  insert into public.prices(origin,market,dest,month,direct,any_stops,updated_at,price_source)
    values(p.origin,p.market,p.dest,p.month,p.direct,p.any_stops,p.updated_at,p.price_source)
    on conflict(origin,dest,month) do update set market=excluded.market,direct=excluded.direct,
      any_stops=excluded.any_stops,updated_at=excluded.updated_at,price_source=excluded.price_source;
  insert into public.offers(origin,market,dest,month,flight_type,departure_at,return_at,nights,price,transfers,airline,
    updated_at,in_cheap_pool,target_nights,target_exact,target_actual_nights,in_break_window,price_source)
    select origin,market,dest,month,flight_type,departure_at,return_at,nights,price,transfers,airline,
      updated_at,in_cheap_pool,target_nights,target_exact,target_actual_nights,in_break_window,price_source
    from jsonb_populate_recordset(null::public.offers,p_offers)
    on conflict(origin,dest,month,flight_type,departure_at,return_at) do update set
      market=excluded.market,nights=excluded.nights,price=excluded.price,transfers=excluded.transfers,
      airline=excluded.airline,updated_at=excluded.updated_at,in_cheap_pool=excluded.in_cheap_pool,
      target_nights=excluded.target_nights,target_exact=excluded.target_exact,
      target_actual_nights=excluded.target_actual_nights,in_break_window=excluded.in_break_window,price_source=excluded.price_source;
  -- Same retention-only policy as the deployed main collector: an empty response
  -- does not delete an unconfirmed future offer.
  delete from public.offers where origin=p.origin and dest=p.dest and month=p.month
    and (departure_at < (clock_timestamp() at time zone 'Europe/Berlin')::date
      or updated_at < clock_timestamp()-interval '365 days');
  return true;
end;
$$;

create or replace function public.collection_commit_window(p_owner uuid,p_token bigint,p_fare jsonb,p_miss jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare f public.window_prices; m public.window_price_misses;
begin
  perform 1 from public.collection_scheduler_state where singleton and owner=p_owner
    and fence=p_token and lease_until>clock_timestamp() for update;
  if not found then raise exception 'collection lease lost'; end if;
  if (p_fare is null) = (p_miss is null) then raise exception 'exactly one outcome required'; end if;
  if p_fare is not null then
    f := jsonb_populate_record(null::public.window_prices,p_fare);
    if f.market is distinct from public.aviasales_market_for_origin(f.origin) then raise exception 'invalid market'; end if;
    insert into public.window_prices(origin,market,dest,flight_type,departure_at,return_at,nights,price,transfers,airline,updated_at,price_source,window_kind)
      values(f.origin,f.market,f.dest,f.flight_type,f.departure_at,f.return_at,f.nights,f.price,f.transfers,f.airline,f.updated_at,f.price_source,f.window_kind)
      on conflict(origin,dest,flight_type,departure_at,return_at) do update set market=excluded.market,nights=excluded.nights,
        price=excluded.price,transfers=excluded.transfers,airline=excluded.airline,updated_at=excluded.updated_at,price_source=excluded.price_source,window_kind=excluded.window_kind;
    delete from public.window_price_misses where origin=f.origin and dest=f.dest and flight_type=f.flight_type
      and departure_at=f.departure_at and return_at=f.return_at;
  else
    m := jsonb_populate_record(null::public.window_price_misses,p_miss);
    if m.market is distinct from public.aviasales_market_for_origin(m.origin) then raise exception 'invalid market'; end if;
    insert into public.window_price_misses(origin,market,dest,flight_type,departure_at,return_at,window_kind,outcome,detail,checked_at)
      values(m.origin,m.market,m.dest,m.flight_type,m.departure_at,m.return_at,m.window_kind,m.outcome,m.detail,m.checked_at)
      on conflict(origin,dest,flight_type,departure_at,return_at) do update set market=excluded.market,
        window_kind=excluded.window_kind,outcome=excluded.outcome,detail=excluded.detail,checked_at=excluded.checked_at;
  end if;
  return true;
end;
$$;
revoke all on function public.collection_commit_main(uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.collection_commit_window(uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.collection_commit_main(uuid,bigint,jsonb,jsonb) to service_role;
grant execute on function public.collection_commit_window(uuid,bigint,jsonb,jsonb) to service_role;

create or replace function public.collection_commit_roulette(p_owner uuid,p_token bigint,p_ticket jsonb,p_result jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare t public.offers; r public.offers;
begin
  perform 1 from public.collection_scheduler_state where singleton and owner=p_owner
    and fence=p_token and lease_until>clock_timestamp() for update;
  if not found then raise exception 'collection lease lost'; end if;
  t := jsonb_populate_record(null::public.offers,p_ticket);
  if p_result->>'status'='found' then
    r := jsonb_populate_record(null::public.offers,p_result);
    if r.price is null or r.price<=0 or r.updated_at is null then raise exception 'invalid confirmed fare'; end if;
    update public.offers set price=r.price,transfers=r.transfers,airline=r.airline,
      updated_at=r.updated_at,price_source=r.price_source,market=public.aviasales_market_for_origin(t.origin)
      where origin=t.origin and dest=t.dest and month=t.month and flight_type=t.flight_type
        and departure_at=t.departure_at and return_at=t.return_at;
  elsif p_result->>'status'='no_result' then
    delete from public.offers where origin=t.origin and dest=t.dest and month=t.month
      and flight_type=t.flight_type and departure_at=t.departure_at and return_at=t.return_at;
  end if;
  return true;
end;
$$;
revoke all on function public.collection_commit_roulette(uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.collection_commit_roulette(uuid,bigint,jsonb,jsonb) to service_role;
commit;
notify pgrst, 'reload schema';
