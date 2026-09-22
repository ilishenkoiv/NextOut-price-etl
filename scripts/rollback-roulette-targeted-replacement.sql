-- RECOVERY ONLY. Do not run as a substitute for the fix-forward plan.
-- If correction validation fails, keep all collection schedules paused, restore this exact
-- owner-captured pre-migration function, verify readback, and do not run the new collector.
begin;
set local lock_timeout='10s';
CREATE OR REPLACE FUNCTION public.collection_commit_roulette(p_owner uuid, p_token bigint, p_ticket jsonb, p_result jsonb)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
    delete from public.daily_origin_cheapest_pool p
      where p.origin=t.origin and p.dest=t.dest and p.flight_type=t.flight_type
        and p.departure_at=t.departure_at and p.return_at is not distinct from t.return_at;
  end if;
  return true;
end;
$function$;
revoke all on function public.collection_commit_roulette(uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.collection_commit_roulette(uuid,bigint,jsonb,jsonb) to service_role;
commit;
notify pgrst,'reload schema';
