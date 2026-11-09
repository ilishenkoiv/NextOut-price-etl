-- Add a no-data-loss publication-rate fence to the existing selected-carousel base RPC.
-- The public wrapper and all persisted data remain unchanged.
begin;
set local lock_timeout = '10s';

do $$
begin
  if to_regprocedure('public.collection_commit_selected_carousel_base_20261106(jsonb,bigint,jsonb)') is null then
    raise exception 'selected carousel base RPC contract is missing';
  end if;
  if to_regclass('public.selected_price_refresh_control') is null
    or to_regclass('public.daily_origin_window_candidate_runs') is null
    or to_regclass('public.daily_origin_window_candidates') is null
    or to_regclass('public.daily_origin_window_candidate_revisions') is null
    or to_regclass('public.daily_origin_window_candidate_revision_candidates') is null then
    raise exception 'selected carousel revision tables are missing';
  end if;
end;
$$;

create or replace function public.collection_commit_selected_carousel_base_20261106(
  p_ticket jsonb,p_generation bigint,p_result jsonb
) returns boolean language plpgsql security definer set search_path=public as $$
declare
  v_day date;
  v_origin text;
  v_snapshot timestamptz;
  v_revision integer;
  v_next timestamptz;
  v_rows integer;
  v_candidate_rows integer;
  v_request_groups integer;
  v_replacement_pending jsonb;
begin
  if not exists(select 1 from public.selected_price_refresh_control where singleton=true and enabled and not main12h_rollback and generation=p_generation) then return false; end if;
  v_day:=(p_ticket->>'observed_on')::date;
  v_origin:=p_ticket->>'origin';
  v_snapshot:=(p_ticket->>'snapshot_at')::timestamptz;
  if v_day is null or v_origin !~ '^[A-Z]{3}$' or v_snapshot is null or coalesce(p_result->>'status','') not in ('found','confirmed_absent','error','technical','timeout','rate_limit','unconfirmed') then raise exception 'invalid selected carousel revision'; end if;

  perform pg_advisory_xact_lock(hashtext('selected-carousel:'||v_day::text||':'||v_origin));
  v_next:=clock_timestamp();

  -- A selected ticket is bound to the immutable per-origin base publication it came from.
  -- Never let a delayed ticket publish a revision from a different same-day snapshot.
  if not exists(
    select 1 from public.daily_origin_window_candidate_runs r
    where r.observed_on=v_day and r.origin=v_origin and r.snapshot_at=v_snapshot
      and r.candidate_rows=(select count(*) from public.daily_origin_window_candidates c
        where c.observed_on=v_day and c.origin=v_origin and c.snapshot_at=v_snapshot)
      and r.exact_request_groups=(select count(distinct concat_ws('|',c.flight_type,c.departure_at,c.return_at))
        from public.daily_origin_window_candidates c where c.observed_on=v_day and c.origin=v_origin and c.snapshot_at=v_snapshot)
  ) then raise exception 'stale selected carousel ticket snapshot'; end if;

  -- The public replacement wrapper emits its two verified facts through this private base in
  -- one transaction: the old city is confirmed absent, then its exact-date alternate is found.
  -- Keep the first fact transaction-local and consume it once for the matching second fact;
  -- a separate call never receives this marker and remains a no-write inside the fence.
  v_replacement_pending:=nullif(current_setting('nextout.selected_carousel_replacement_pending',true),'')::jsonb;

  -- The existing lock serializes this origin. A completed revision less than 30 minutes old
  -- is already the current truthful full-origin publication, so this valid call is a no-op,
  -- except for the wrapper's immediately following alternate materialization described above.
  if exists(
    select 1 from public.daily_origin_window_candidate_revisions r
    where r.observed_on=v_day and r.origin=v_origin
      and r.completed_at>v_next-interval '30 minutes'
  ) then
    if coalesce(p_result->>'status','')='found'
      and v_replacement_pending is not null
      and (v_replacement_pending->>'observed_on')::date=v_day
      and v_replacement_pending->>'origin'=v_origin
      and (v_replacement_pending->>'snapshot_at')::timestamptz=v_snapshot
      and (v_replacement_pending->>'generation')::bigint=p_generation
      and v_replacement_pending->>'flight_type'=p_ticket->>'flight_type'
      and (v_replacement_pending->>'departure_at')::date=(p_ticket->>'departure_at')::date
      and (v_replacement_pending->>'return_at')::date=(p_ticket->>'return_at')::date
      and v_replacement_pending->>'destination_id' is not null
      and p_ticket->>'destination_id' is not null
      and v_replacement_pending->>'destination_id' is distinct from p_ticket->>'destination_id'
      and v_replacement_pending->>'dest' is not null
      and p_ticket->>'dest' is not null
      and v_replacement_pending->>'dest' is distinct from p_ticket->>'dest'
    then
      perform set_config('nextout.selected_carousel_replacement_pending','',true);
    else
      return true;
    end if;
  end if;

  select coalesce(max(revision),0)+1 into v_revision from public.daily_origin_window_candidate_revisions where observed_on=v_day and origin=v_origin;
  insert into public.daily_origin_window_candidate_revisions(observed_on,origin,revision,snapshot_at,candidate_rows,exact_request_groups)
    select v_day,v_origin,v_revision,v_next,count(*),count(distinct concat_ws('|',flight_type,departure_at,return_at))
    from public.daily_origin_window_candidates where observed_on=v_day and origin=v_origin and snapshot_at=v_snapshot;
  get diagnostics v_rows=row_count;
  if v_rows=0 then raise exception 'missing base origin carousel publication'; end if;

  insert into public.daily_origin_window_candidate_revision_candidates(observed_on,origin,snapshot_at,market,flight_type,region_codes,window_kind,departure_at,return_at,position,dest,destination_id,source_destination_id,exact_price,currency,transfers,airline,exact_observed_at,refresh_status,refresh_checked_at,last_error_kind,price_source)
  select c.observed_on,c.origin,v_next,c.market,c.flight_type,c.region_codes,c.window_kind,c.departure_at,c.return_at,c.position,
    case when c.source_destination_id=p_ticket->>'destination_id' and c.flight_type=p_ticket->>'flight_type' and c.departure_at=(p_ticket->>'departure_at')::date and c.return_at=(p_ticket->>'return_at')::date and p_result->>'outcome'='replaced' then p_result#>>'{replacement,dest}' else c.dest end,
    case when c.source_destination_id=p_ticket->>'destination_id' and c.flight_type=p_ticket->>'flight_type' and c.departure_at=(p_ticket->>'departure_at')::date and c.return_at=(p_ticket->>'return_at')::date and p_result->>'outcome'='replaced' then p_result#>>'{replacement,destination_id}' else c.destination_id end,
    c.source_destination_id,
    case when c.source_destination_id=p_ticket->>'destination_id' and c.flight_type=p_ticket->>'flight_type' and c.departure_at=(p_ticket->>'departure_at')::date and c.return_at=(p_ticket->>'return_at')::date and p_result->>'status'='found' then (p_result#>>'{fare,price}')::numeric when c.source_destination_id=p_ticket->>'destination_id' and c.flight_type=p_ticket->>'flight_type' and c.departure_at=(p_ticket->>'departure_at')::date and c.return_at=(p_ticket->>'return_at')::date and p_result->>'outcome'='replaced' then (p_result#>>'{replacement,price}')::numeric else c.exact_price end,
    c.currency,c.transfers,c.airline,
    case when c.source_destination_id=p_ticket->>'destination_id' and c.flight_type=p_ticket->>'flight_type' and c.departure_at=(p_ticket->>'departure_at')::date and c.return_at=(p_ticket->>'return_at')::date and p_result->>'status'='found' then (p_result#>>'{fare,updated_at}')::timestamptz when c.source_destination_id=p_ticket->>'destination_id' and c.flight_type=p_ticket->>'flight_type' and c.departure_at=(p_ticket->>'departure_at')::date and c.return_at=(p_ticket->>'return_at')::date and p_result->>'outcome'='replaced' then (p_result#>>'{replacement,updated_at}')::timestamptz else c.exact_observed_at end,
    case when c.source_destination_id=p_ticket->>'destination_id' and c.flight_type=p_ticket->>'flight_type' and c.departure_at=(p_ticket->>'departure_at')::date and c.return_at=(p_ticket->>'return_at')::date and p_result->>'status'='found' then 'fresh' when c.source_destination_id=p_ticket->>'destination_id' and c.flight_type=p_ticket->>'flight_type' and c.departure_at=(p_ticket->>'departure_at')::date and c.return_at=(p_ticket->>'return_at')::date and p_result->>'outcome'='replaced' and (p_result#>>'{replacement,updated_at}')::timestamptz>=v_next-interval '30 minutes' then 'fresh' when c.source_destination_id=p_ticket->>'destination_id' and c.flight_type=p_ticket->>'flight_type' and c.departure_at=(p_ticket->>'departure_at')::date and c.return_at=(p_ticket->>'return_at')::date and p_result->>'outcome'='replaced' then 'failed' when c.source_destination_id=p_ticket->>'destination_id' and c.flight_type=p_ticket->>'flight_type' and c.departure_at=(p_ticket->>'departure_at')::date and c.return_at=(p_ticket->>'return_at')::date and p_result->>'outcome'='retain_fresh' then c.refresh_status when c.source_destination_id=p_ticket->>'destination_id' and c.flight_type=p_ticket->>'flight_type' and c.departure_at=(p_ticket->>'departure_at')::date and c.return_at=(p_ticket->>'return_at')::date then 'failed' else c.refresh_status end,clock_timestamp(),null,c.price_source
  from (
    select observed_on,origin,market,flight_type,region_codes,window_kind,departure_at,return_at,position,dest,destination_id,source_destination_id,exact_price,currency,transfers,airline,exact_observed_at,refresh_status,refresh_checked_at,last_error_kind,price_source
      from public.daily_origin_window_candidate_revision_candidates where snapshot_at=(select snapshot_at from public.daily_origin_window_candidate_revisions where observed_on=v_day and origin=v_origin and revision<v_revision order by revision desc limit 1)
    union all
    select observed_on,origin,market,flight_type,region_codes,window_kind,departure_at,return_at,position,dest,destination_id,destination_id,exact_price,currency,transfers,airline,exact_observed_at,refresh_status,refresh_checked_at,last_error_kind,price_source
      from public.daily_origin_window_candidates where observed_on=v_day and origin=v_origin and snapshot_at=v_snapshot and not exists(select 1 from public.daily_origin_window_candidate_revisions where observed_on=v_day and origin=v_origin and revision<v_revision)
  ) c;

  select count(*),count(distinct concat_ws('|',flight_type,departure_at,return_at)) into v_candidate_rows,v_request_groups
    from public.daily_origin_window_candidate_revision_candidates where observed_on=v_day and origin=v_origin and snapshot_at=v_next;
  if v_candidate_rows<>(select candidate_rows from public.daily_origin_window_candidate_revisions where observed_on=v_day and origin=v_origin and revision=v_revision)
    or v_request_groups<>(select exact_request_groups from public.daily_origin_window_candidate_revisions where observed_on=v_day and origin=v_origin and revision=v_revision) then
    raise exception 'incomplete selected carousel revision';
  end if;
  if p_result->>'status'='confirmed_absent' then
    perform set_config('nextout.selected_carousel_replacement_pending',jsonb_build_object(
      'observed_on',v_day,'origin',v_origin,'snapshot_at',v_snapshot,
      'generation',p_generation,'destination_id',p_ticket->>'destination_id','dest',p_ticket->>'dest',
      'flight_type',p_ticket->>'flight_type',
      'departure_at',(p_ticket->>'departure_at')::date,'return_at',(p_ticket->>'return_at')::date
    )::text,true);
  end if;
  return true;
end;
$$;

revoke all on function public.collection_commit_selected_carousel_base_20261106(jsonb,bigint,jsonb) from public,anon,authenticated,service_role;
commit;
notify pgrst, 'reload schema';
