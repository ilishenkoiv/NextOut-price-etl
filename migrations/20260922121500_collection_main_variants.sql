-- Replace the already-deployed main commit RPC so independently observed direct/any values merge
-- without erasing the known opposite side. APPLY MANUALLY; no production application by this task.
-- Readback: select pg_get_functiondef('public.collection_commit_main(uuid,bigint,jsonb,jsonb)'::regprocedure);
-- Rollback: re-apply migrations/20260916141000_collection_atomic_writes.sql from the accepted prior release.
begin;
create or replace function public.collection_commit_main(p_owner uuid,p_token bigint,p_price jsonb,p_offers jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare p public.prices; old_price public.prices; direct_seen boolean; any_seen boolean;
  merged_direct public.prices.direct%type; merged_any public.prices.any_stops%type; merged_source jsonb;
begin
  perform 1 from public.collection_scheduler_state where singleton and owner=p_owner
    and fence=p_token and lease_until>clock_timestamp() for update;
  if not found then raise exception 'collection lease lost'; end if;
  p:=jsonb_populate_record(null::public.prices,p_price);
  direct_seen:=coalesce((p_price->>'direct_observed')::boolean,false);
  any_seen:=coalesce((p_price->>'any_observed')::boolean,false);
  if p.origin is null or p.dest is null or p.origin=p.dest or p.month is null
    or p.market is distinct from public.aviasales_market_for_origin(p.origin) or p.updated_at is null
    or jsonb_typeof(p_offers) is distinct from 'array' or not(direct_seen or any_seen)
    or (p.direct is null and p.any_stops is null) then raise exception 'invalid cell'; end if;
  if exists(select 1 from jsonb_array_elements(p_offers) o where o->>'origin' is distinct from p.origin
    or o->>'dest' is distinct from p.dest or o->>'month' is distinct from p.month
    or o->>'market' is distinct from p.market) then raise exception 'mixed cell'; end if;
  select * into old_price from public.prices where origin=p.origin and dest=p.dest and month=p.month;
  merged_direct:=case when direct_seen and p.direct is not null then p.direct else old_price.direct end;
  merged_any:=case when any_seen and p.any_stops is not null then p.any_stops else old_price.any_stops end;
  merged_source:=coalesce(old_price.price_source,'{}'::jsonb)||(coalesce(p.price_source,'{}'::jsonb)-'variants')||
    jsonb_build_object('variants',coalesce(old_price.price_source->'variants','{}'::jsonb)
      ||case when direct_seen and p.direct is not null then jsonb_build_object('direct',p.price_source->'variants'->'direct') else '{}'::jsonb end
      ||case when any_seen and p.any_stops is not null then jsonb_build_object('any',p.price_source->'variants'->'any') else '{}'::jsonb end);
  if old_price.origin is null or (old_price.direct,old_price.any_stops) is distinct from (merged_direct,merged_any) then
    insert into public.price_history(origin,market,dest,month,direct,any_stops)
      values(p.origin,p.market,p.dest,p.month,merged_direct,merged_any);
  end if;
  insert into public.prices(origin,market,dest,month,direct,any_stops,updated_at,price_source)
    values(p.origin,p.market,p.dest,p.month,merged_direct,merged_any,p.updated_at,merged_source)
    on conflict(origin,dest,month) do update set market=excluded.market,direct=excluded.direct,
      any_stops=excluded.any_stops,updated_at=excluded.updated_at,price_source=excluded.price_source;
  insert into public.offers(origin,market,dest,month,flight_type,departure_at,return_at,nights,price,transfers,airline,
    updated_at,in_cheap_pool,target_nights,target_exact,target_actual_nights,in_break_window,price_source)
    select origin,market,dest,month,flight_type,departure_at,return_at,nights,price,transfers,airline,
      updated_at,in_cheap_pool,target_nights,target_exact,target_actual_nights,in_break_window,price_source
    from jsonb_populate_recordset(null::public.offers,p_offers)
    on conflict(origin,dest,month,flight_type,departure_at,return_at) do update set market=excluded.market,
      nights=excluded.nights,price=excluded.price,transfers=excluded.transfers,airline=excluded.airline,
      updated_at=excluded.updated_at,in_cheap_pool=excluded.in_cheap_pool,target_nights=excluded.target_nights,
      target_exact=excluded.target_exact,target_actual_nights=excluded.target_actual_nights,
      in_break_window=excluded.in_break_window,price_source=excluded.price_source;
  delete from public.offers where origin=p.origin and dest=p.dest and month=p.month
    and (departure_at<(clock_timestamp() at time zone 'Europe/Berlin')::date
      or updated_at<clock_timestamp()-interval '365 days');
  return true;
end;
$$;
revoke all on function public.collection_commit_main(uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.collection_commit_main(uuid,bigint,jsonb,jsonb) to service_role;
commit;
notify pgrst, 'reload schema';
