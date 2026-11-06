-- OWNER-MANUAL ONLY. Apply once, after independent source/SQL review and the preflight readback.
-- It preserves the existing pool/revision identities and indexes. No table or workflow is added.
begin;
set local lock_timeout = '10s';

do $$
begin
  if to_regprocedure('public.collection_commit_selected_roulette(uuid,bigint,bigint,jsonb,jsonb)') is null
    or to_regprocedure('public.collection_commit_selected_carousel(jsonb,bigint,jsonb)') is null then
    raise exception 'selected refresh target RPC contract is missing';
  end if;
  if to_regprocedure('public.collection_commit_selected_roulette_base_20261106(uuid,bigint,bigint,jsonb,jsonb)') is not null
    or to_regprocedure('public.collection_commit_selected_carousel_base_20261106(jsonb,bigint,jsonb)') is not null then
    raise exception 'selected refresh recovery migration was already prepared';
  end if;
end;
$$;

alter table public.roulette_pool_ticket_revisions
  add column if not exists replacement_ticket jsonb;

-- Preserve the owner-applied definitions as private bases. The wrappers below change only the
-- recovery branch: confirmed absence may exclude an old ticket only when it carries a validated
-- fresh alternate; all retained/unconfirmed outcomes leave the old displayed ticket untouched.
alter function public.collection_commit_selected_roulette(uuid,bigint,bigint,jsonb,jsonb)
  rename to collection_commit_selected_roulette_base_20261106;
alter function public.collection_commit_selected_carousel(jsonb,bigint,jsonb)
  rename to collection_commit_selected_carousel_base_20261106;

create function public.collection_commit_selected_roulette(
  p_owner uuid,p_token bigint,p_generation bigint,p_ticket jsonb,p_result jsonb
) returns boolean language plpgsql security definer set search_path=public as $$
declare
  v_snapshot timestamptz:=(p_ticket->>'snapshot_at')::timestamptz;
  v_origin text:=p_ticket->>'origin';
  v_dest text:=p_ticket->>'dest';
  v_mode text:=p_ticket->>'flight_type';
  v_rank integer:=nullif(p_ticket->>'rank','')::integer;
  v_departure date:=(p_ticket->>'departure_at')::date;
  v_return date:=(p_ticket->>'return_at')::date;
  v_status text:=coalesce(p_result->>'status','');
  v_outcome text:=coalesce(p_result->>'outcome','');
  v_current jsonb;
  v_alternate jsonb;
  v_replacement jsonb;
  v_rows integer;
  v_ranks integer;
  v_destinations integer;
  v_updated integer;
begin
  perform 1 from public.collection_scheduler_state
    where singleton and owner=p_owner and fence=p_token and lease_until>clock_timestamp() for update;
  if not found then raise exception 'collection lease lost'; end if;
  if not exists(select 1 from public.selected_price_refresh_control
      where singleton and enabled and not main12h_rollback and generation=p_generation) then
    return false;
  end if;
  if v_snapshot is null or coalesce(v_origin,'') !~ '^[A-Z]{3}$' or coalesce(v_dest,'') !~ '^[A-Z]{3}$'
    or coalesce(v_mode,'') not in ('any','direct') or coalesce(v_rank,0) not between 1 and 10 or v_departure is null or v_return is null then
    raise exception 'invalid selected roulette ticket';
  end if;
  select to_jsonb(p) into v_current from public.daily_origin_cheapest_pool p
    where p.snapshot_at=v_snapshot and p.origin=v_origin and p.flight_type=v_mode and p.rank=v_rank and p.dest=v_dest
      and p.departure_at=v_departure and p.return_at is not distinct from v_return for update;
  if v_current is null then raise exception 'selected roulette target changed'; end if;

  if v_status='found' then
    perform public.collection_commit_selected_roulette_base_20261106(p_owner,p_token,p_generation,p_ticket,p_result);
    update public.roulette_pool_ticket_revisions set replacement_ticket=null
      where snapshot_at=v_snapshot and origin=v_origin and flight_type=v_mode and rank=v_rank and dest=v_dest
        and departure_at=v_departure and return_at is not distinct from v_return and generation=p_generation;
    return true;
  end if;

  -- A timeout, provider error, malformed payload, or a confirmed absence without a confirmed
  -- alternate is intentionally a retention no-op. It cannot exclude the displayed city/price.
  if v_status='unconfirmed' or (v_status='confirmed_absent' and v_outcome='retained') then return true; end if;
  if v_status is distinct from 'confirmed_absent' or v_outcome is distinct from 'replaced'
    or jsonb_typeof(p_result->'replacement') is distinct from 'object' then
    raise exception 'invalid selected roulette result';
  end if;

  select count(*),count(distinct rank),count(distinct dest) into v_rows,v_ranks,v_destinations
    from public.daily_origin_cheapest_pool
    where snapshot_at=v_snapshot and origin=v_origin;
  if v_rows<>10 or v_ranks<>10 or v_destinations<>10
    or exists(select 1 from public.daily_origin_cheapest_pool where snapshot_at=v_snapshot and origin=v_origin and rank not between 1 and 10) then
    raise exception 'selected roulette pool is not an exact pool10';
  end if;

  select to_jsonb(p) into v_alternate from public.daily_origin_cheapest_pool p
    where p.snapshot_at=v_snapshot and p.origin=v_origin
      and p.dest=p_result#>>'{replacement,dest}'
      and p.flight_type=p_result#>>'{replacement,flight_type}'
      and p.rank=(p_result#>>'{replacement,rank}')::integer
      and p.departure_at=(p_result#>>'{replacement,departure_at}')::date
      and p.return_at is not distinct from (p_result#>>'{replacement,return_at}')::date
    for update;
  if v_alternate is null or v_alternate->>'dest'=v_dest
    or coalesce((v_alternate->>'price')::numeric,0)<=0
    or coalesce((v_alternate->>'transfers')::integer,-1)<0
    or (v_alternate->>'flight_type'='direct' and (v_alternate->>'transfers')::integer<>0)
    or (v_alternate->>'source_updated_at')::timestamptz<clock_timestamp()-interval '30 minutes'
    or (v_alternate->>'source_updated_at')::timestamptz>clock_timestamp()+interval '5 minutes'
    or (p_result#>>'{replacement,price}')::numeric is distinct from (v_alternate->>'price')::numeric
    or (p_result#>>'{replacement,transfers}')::integer is distinct from (v_alternate->>'transfers')::integer
    or (p_result#>>'{replacement,updated_at}')::timestamptz is distinct from (v_alternate->>'source_updated_at')::timestamptz then
    raise exception 'invalid or stale selected roulette alternate';
  end if;
  if not exists(
    select 1 from public.roulette_pool_ticket_revisions r
    where r.snapshot_at=v_snapshot and r.origin=v_origin and r.flight_type=v_alternate->>'flight_type'
      and r.rank=(v_alternate->>'rank')::integer and r.dest=v_alternate->>'dest'
      and r.departure_at=(v_alternate->>'departure_at')::date
      and r.return_at is not distinct from (v_alternate->>'return_at')::date
      and r.generation=p_generation and r.visibility='verified' and r.reason is null
  ) then raise exception 'selected roulette alternate is not a verified available revision'; end if;

  v_replacement:=jsonb_build_object(
    'observed_on',v_alternate->'observed_on','snapshot_at',v_alternate->'snapshot_at','origin',v_alternate->'origin',
    'dest',v_alternate->'dest','flight_type',v_alternate->'flight_type','rank',v_alternate->'rank',
    'departure_at',v_alternate->'departure_at','return_at',v_alternate->'return_at','price',v_alternate->'price',
    'transfers',v_alternate->'transfers','updated_at',v_alternate->'source_updated_at','price_source',v_alternate->'price_source'
  );
  perform public.collection_commit_selected_roulette_base_20261106(
    p_owner,p_token,p_generation,p_ticket,jsonb_build_object('status','no_result')
  );
  update public.roulette_pool_ticket_revisions set replacement_ticket=v_replacement
    where snapshot_at=v_snapshot and origin=v_origin and flight_type=v_mode and rank=v_rank and dest=v_dest
      and departure_at=v_departure and return_at is not distinct from v_return and generation=p_generation;
  get diagnostics v_updated=row_count;
  if v_updated<>1 then raise exception 'selected roulette replacement revision changed'; end if;
  return true;
end;
$$;

create function public.collection_commit_selected_carousel(
  p_ticket jsonb,p_generation bigint,p_result jsonb
) returns boolean language plpgsql security definer set search_path=public as $$
declare
  v_status text:=coalesce(p_result->>'status','');
  v_outcome text:=coalesce(p_result->>'outcome','');
  v_replacement jsonb:=p_result->'replacement';
  v_candidate jsonb;
begin
  if not exists(select 1 from public.selected_price_refresh_control
      where singleton and enabled and not main12h_rollback and generation=p_generation) then
    return false;
  end if;
  if v_status='found' then
    return public.collection_commit_selected_carousel_base_20261106(p_ticket,p_generation,p_result);
  end if;
  -- Do not record an unconfirmed technical outcome as a failed/absent city: the exact prior
  -- candidate and its displayed price remain the only truthful output until a later confirmation.
  if v_status='unconfirmed' then return true; end if;
  if v_status is distinct from 'confirmed_absent' then raise exception 'invalid selected carousel result'; end if;
  -- A confirmed absence without a separately verified alternate is an explicit no-op: leave the
  -- exact old city and its displayed from-price as they are.
  if v_outcome='retained' then return true; end if;
  if v_outcome is distinct from 'replaced' or jsonb_typeof(v_replacement) is distinct from 'object'
    or v_replacement->>'origin' is distinct from p_ticket->>'origin'
    or v_replacement->>'flight_type' is distinct from p_ticket->>'flight_type'
    or (v_replacement->>'departure_at')::date is distinct from (p_ticket->>'departure_at')::date
    or (v_replacement->>'return_at')::date is distinct from (p_ticket->>'return_at')::date
    or v_replacement->>'dest' is null or v_replacement->>'dest'=p_ticket->>'dest'
    or v_replacement->>'destination_id' is null or v_replacement->>'destination_id'=p_ticket->>'destination_id'
    or coalesce((v_replacement->>'price')::numeric,0)<=0
    or coalesce((v_replacement->>'transfers')::integer,-1)<0
    or (v_replacement->>'flight_type'='direct' and (v_replacement->>'transfers')::integer<>0)
    or (v_replacement->>'updated_at')::timestamptz<clock_timestamp()-interval '30 minutes'
    or (v_replacement->>'updated_at')::timestamptz>clock_timestamp()+interval '5 minutes' then
    raise exception 'invalid or stale selected carousel alternate';
  end if;
  select to_jsonb(c) into v_candidate from public.daily_window_candidates c
    where c.observed_on=(v_replacement->>'observed_on')::date
      and c.snapshot_at=(v_replacement->>'snapshot_at')::timestamptz
      and c.origin=v_replacement->>'origin' and c.destination_id=v_replacement->>'destination_id'
      and c.dest=v_replacement->>'dest' and c.flight_type=v_replacement->>'flight_type'
      and c.departure_at=(v_replacement->>'departure_at')::date
      and c.return_at=(v_replacement->>'return_at')::date
    for update;
  if v_candidate is null or v_candidate->>'refresh_status' is distinct from 'fresh'
    or coalesce((v_candidate->>'exact_price')::numeric,0)<=0
    or coalesce((v_candidate->>'transfers')::integer,-1)<0
    or (v_candidate->>'flight_type'='direct' and (v_candidate->>'transfers')::integer<>0)
    or (v_candidate->>'exact_observed_at')::timestamptz<clock_timestamp()-interval '30 minutes'
    or (v_candidate->>'exact_observed_at')::timestamptz>clock_timestamp()+interval '5 minutes'
    or (v_replacement->>'price')::numeric is distinct from (v_candidate->>'exact_price')::numeric
    or (v_replacement->>'transfers')::integer is distinct from (v_candidate->>'transfers')::integer
    or nullif(v_replacement->>'airline','') is distinct from nullif(v_candidate->>'airline','')
    or (v_replacement->>'updated_at')::timestamptz is distinct from (v_candidate->>'exact_observed_at')::timestamptz
    or v_replacement->'price_source' is distinct from v_candidate->'price_source' then
    raise exception 'selected carousel alternate is not a current fresh candidate';
  end if;
  -- The base routine accepts only a fare for its own factual ticket. Commit the two exact facts
  -- atomically here: the old city is confirmed absent, then the verified alternate is refreshed.
  -- No different destination is ever delegated to the unchanged base RPC.
  perform public.collection_commit_selected_carousel_base_20261106(
    p_ticket,p_generation,jsonb_build_object('status','confirmed_absent')
  );
  return public.collection_commit_selected_carousel_base_20261106(
    jsonb_build_object(
      'observed_on',v_candidate->'observed_on','snapshot_at',v_candidate->'snapshot_at','origin',v_candidate->'origin',
      'destination_id',v_candidate->'destination_id','dest',v_candidate->'dest','flight_type',v_candidate->'flight_type',
      'departure_at',v_candidate->'departure_at','return_at',v_candidate->'return_at','position',v_candidate->'position'
    ),p_generation,jsonb_build_object('status','found','fare',jsonb_build_object(
      'price',v_candidate->'exact_price','transfers',v_candidate->'transfers','airline',v_candidate->'airline',
      'updated_at',v_candidate->'exact_observed_at','price_source',v_candidate->'price_source'
    ))
  );
end;
$$;

revoke all on function public.collection_commit_selected_roulette_base_20261106(uuid,bigint,bigint,jsonb,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.collection_commit_selected_carousel_base_20261106(jsonb,bigint,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.collection_commit_selected_roulette(uuid,bigint,bigint,jsonb,jsonb) from public,anon,authenticated;
revoke all on function public.collection_commit_selected_carousel(jsonb,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.collection_commit_selected_roulette(uuid,bigint,bigint,jsonb,jsonb) to service_role;
grant execute on function public.collection_commit_selected_carousel(jsonb,bigint,jsonb) to service_role;
commit;
notify pgrst, 'reload schema';
