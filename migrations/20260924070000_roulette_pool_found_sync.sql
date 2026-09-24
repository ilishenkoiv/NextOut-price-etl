-- The 'found' branch of collection_commit_roulette (20260922130000) confirms the exact-date
-- fare and writes it to public.offers, but never touches public.daily_origin_cheapest_pool —
-- the table the app actually reads for the roulette list (src/lib/dailyOriginCheapest.ts).
-- Measured 2026-09-24: the coordinator's roulette checkpoint reaches cursor=total ("N/N done")
-- every ~30 minutes, but that counter advances on 'found', on a deferred technical error, AND on
-- a resolved replacement alike — "N/N done" means every slot was walked this cycle, NOT that N
-- prices were confirmed-fresh. Read-only join of production daily_origin_cheapest_pool vs offers
-- (170 of today's tickets, after the last two due cycles): 169/170 pool rows had source_updated_at
-- older than 90 minutes (most 6-12+ hours), while the matched offers.updated_at was fresh
-- (<=30 min) for 156/157 — confirming the coordinator DOES keep re-confirming exact prices into
-- offers every cycle, but only the rare 'no_result' replacement path ever refreshes the pool the
-- app actually reads; a normal 'found' re-confirmation was invisible to the list.
--
-- This migration adds ONE additional, guarded update inside the same 'found' branch, in the
-- same transaction as the existing public.offers update:
--   - it targets the exact pool row by full identity (snapshot_at, origin, flight_type, rank,
--     dest, departure_at, return_at is not distinct from) — the same key collection_commit_roulette
--     already locks/matches against elsewhere in this function;
--   - if that exact row exists and the observation is fresh (same [-30m, +5m] window already used
--     for replacement candidates elsewhere in this function) but the update matches zero rows
--     (rank/membership changed under it — e.g. a concurrent replacement), the call raises instead
--     of silently returning true, so a caller can never be told "success" while nothing was
--     written;
--   - a stale (or clock-skewed future) provider observation is NEVER written into the pool as if
--     it were fresh — but it is also NOT an error: the collector's error-handling model treats any
--     raised exception from this function as fatal to the whole run (run-collection.mjs's
--     top-level `main().catch` aborts the session on the first thrown error), and one flaky/slow
--     provider response for one ticket must not abort a 30-minute cycle for every other ticket.
--     A stale 'found' response is therefore a silent no-op for the pool (existing pool price/
--     source_updated_at is left exactly as-is, to be tried again next cycle) while public.offers
--     still updates exactly as it always has — unchanged from the prior migration.
-- No other branch, table, route selection or cadence changes.
begin;
set local lock_timeout='10s';

create or replace function public.collection_commit_roulette(p_owner uuid,p_token bigint,p_ticket jsonb,p_result jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare t public.daily_origin_cheapest_pool; r public.offers; candidate public.offers;
  event_id text; allowed text[]; old_json jsonb; new_json jsonb; removed integer; pool_updated integer;
begin
  perform 1 from public.collection_scheduler_state where singleton and owner=p_owner
    and fence=p_token and lease_until>clock_timestamp() for update;
  if not found then raise exception 'collection lease lost'; end if;
  t:=jsonb_populate_record(null::public.daily_origin_cheapest_pool,p_ticket);
  if t.snapshot_at is null or t.origin is null or t.rank is null or t.dest is null
    or t.flight_type is null or t.flight_type not in ('any','direct') or t.departure_at is null or t.return_at is null
    then raise exception 'invalid roulette ticket'; end if;
  event_id:=concat_ws('|',t.snapshot_at,t.origin,t.flight_type,t.rank,t.dest,t.departure_at,t.return_at);
  if exists(select 1 from public.roulette_pool_replacements where event_key=event_id) then return true; end if;

  if p_result->>'status'='found' then
    r:=jsonb_populate_record(null::public.offers,p_result);
    if r.price is null or r.price<=0 or r.updated_at is null then raise exception 'invalid confirmed fare'; end if;
    update public.offers set price=r.price,transfers=r.transfers,airline=r.airline,
      updated_at=r.updated_at,price_source=r.price_source,market=public.aviasales_market_for_origin(t.origin)
      where origin=t.origin and dest=t.dest and month=to_char(t.departure_at,'YYYY-MM')
        and flight_type=t.flight_type and departure_at=t.departure_at and return_at=t.return_at;
    -- Only a fresh observation may be written into the pool as the list's displayed price; a
    -- stale/future one is silently skipped here (offers above already has it) so one flaky
    -- provider response cannot fail the whole collection run.
    if r.updated_at>=clock_timestamp()-interval '30 minutes' and r.updated_at<=clock_timestamp()+interval '5 minutes' then
      update public.daily_origin_cheapest_pool set price=r.price,source_updated_at=r.updated_at,price_source=r.price_source
        where snapshot_at=t.snapshot_at and origin=t.origin and flight_type=t.flight_type and rank=t.rank
          and dest=t.dest and departure_at=t.departure_at and return_at is not distinct from t.return_at;
      get diagnostics pool_updated=row_count;
      if pool_updated<>1 then raise exception 'roulette target changed before confirmed-price sync'; end if;
    end if;
    return true;
  elsif (p_result->>'status') is distinct from 'no_result' then
    return true;
  end if;

  -- Lock the exact selected slot. A stale saved plan may be retried, but it may not replace a
  -- rank that nightly publication (or another fenced attempt) has already changed.
  perform 1 from public.daily_origin_cheapest_pool p
    where p.snapshot_at=t.snapshot_at and p.origin=t.origin and p.flight_type=t.flight_type and p.rank=t.rank
      and p.dest=t.dest and p.departure_at=t.departure_at and p.return_at is not distinct from t.return_at
    for update;
  if not found then raise exception 'roulette target changed before replacement'; end if;

  if jsonb_typeof(p_ticket->'allowed_dests') is distinct from 'array' then raise exception 'missing allowed destinations'; end if;
  select array_agg(value order by value) into allowed from jsonb_array_elements_text(p_ticket->'allowed_dests');
  if allowed is null or cardinality(allowed)<1 or cardinality(allowed)>200
    or exists(select 1 from unnest(allowed) d where d is null or d!~'^[A-Z]{3}$') then raise exception 'invalid allowed destinations'; end if;
  old_json:=to_jsonb(t);
  if p_result->'replacement' is not null and jsonb_typeof(p_result->'replacement')<>'null' then
    candidate:=jsonb_populate_record(null::public.offers,p_result->'replacement');
    if candidate.origin is distinct from t.origin or candidate.flight_type is distinct from t.flight_type
      or candidate.dest is null or candidate.dest=t.dest
      or not(candidate.dest=any(allowed)) or candidate.price is null or candidate.price<=0
      or candidate.market is distinct from public.aviasales_market_for_origin(t.origin)
      or candidate.departure_at is null or candidate.return_at is null or candidate.updated_at is null
      or candidate.departure_at<(clock_timestamp() at time zone 'Europe/Berlin')::date
      or candidate.return_at<=candidate.departure_at or candidate.updated_at<clock_timestamp()-interval '30 minutes'
      or candidate.updated_at>clock_timestamp()+interval '5 minutes'
      or candidate.transfers is null or candidate.transfers<0
      or (candidate.flight_type='direct' and candidate.transfers<>0)
      or candidate.month is distinct from to_char(candidate.departure_at,'YYYY-MM')
      or exists(select 1 from public.daily_origin_cheapest_pool p
        where p.snapshot_at=t.snapshot_at and p.origin=t.origin and p.dest=candidate.dest)
    then raise exception 'invalid or stale roulette replacement'; end if;
  end if;

  -- Remove the confirmed-unavailable tuple from every historical snapshot so app history fallback
  -- cannot resurrect it. This is explicit/audited, never an uncontrolled side effect.
  delete from public.daily_origin_cheapest_pool p where p.origin=t.origin and p.dest=t.dest
    and p.flight_type=t.flight_type and p.departure_at=t.departure_at
    and p.return_at is not distinct from t.return_at;
  get diagnostics removed=row_count;
  if removed<1 then raise exception 'roulette target changed before replacement'; end if;

  if candidate.origin is not null then
    insert into public.offers(origin,market,dest,month,flight_type,departure_at,return_at,nights,price,transfers,airline,updated_at,price_source)
      values(candidate.origin,candidate.market,candidate.dest,candidate.month,candidate.flight_type,candidate.departure_at,candidate.return_at,
        candidate.nights,candidate.price,candidate.transfers,candidate.airline,candidate.updated_at,candidate.price_source)
      on conflict(origin,dest,month,flight_type,departure_at,return_at) do update set market=excluded.market,nights=excluded.nights,
        price=excluded.price,transfers=excluded.transfers,airline=excluded.airline,updated_at=excluded.updated_at,price_source=excluded.price_source;
    insert into public.daily_origin_cheapest_pool(observed_on,snapshot_at,origin,market,flight_type,rank,dest,price,currency,
      departure_at,return_at,transfers,source_updated_at,price_source)
      values(t.observed_on,t.snapshot_at,t.origin,candidate.market,candidate.flight_type,t.rank,candidate.dest,candidate.price,'EUR',
        candidate.departure_at,candidate.return_at,candidate.transfers,candidate.updated_at,candidate.price_source);
    new_json:=jsonb_build_object('origin',candidate.origin,'dest',candidate.dest,'flight_type',candidate.flight_type,
      'departure_at',candidate.departure_at,'return_at',candidate.return_at,'price',candidate.price);
  end if;
  delete from public.offers where origin=t.origin and dest=t.dest and month=to_char(t.departure_at,'YYYY-MM')
    and flight_type=t.flight_type and departure_at=t.departure_at and return_at=t.return_at;
  insert into public.roulette_pool_replacements(event_key,snapshot_at,origin,rank,old_ticket,new_ticket,outcome,reason,historical_rows_removed,run_id)
    values(event_id,t.snapshot_at,t.origin,t.rank,old_json,new_json,case when new_json is null then 'exhausted' else 'replaced' end,
      'confirmed_no_result',removed,nullif(p_ticket->>'run_id',''));
  return true;
end;
$$;
revoke all on function public.collection_commit_roulette(uuid,bigint,jsonb,jsonb) from public,anon,authenticated;
grant execute on function public.collection_commit_roulette(uuid,bigint,jsonb,jsonb) to service_role;

commit;
