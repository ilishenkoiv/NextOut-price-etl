-- Let a persisted roulette checkpoint advance when an older destructive deployment already
-- removed its exact pool slot. Missing slots are retention no-ops; existing slots preserve
-- the immutable-membership and exact-price-only contract from 20260928120000.
begin;
set local lock_timeout='10s';

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
  -- A validated ticket can outlive a slot deleted by the former replacement implementation.
  -- Do not reconstruct it or touch any current, historical, offer, compatibility or audit row.
  if not found then return true; end if;

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

revoke all on function public.collection_commit_roulette(uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.collection_commit_roulette(uuid,bigint,jsonb,jsonb) to service_role;
commit;
notify pgrst,'reload schema';
