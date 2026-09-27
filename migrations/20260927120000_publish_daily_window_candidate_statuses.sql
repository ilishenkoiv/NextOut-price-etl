-- Allow the atomic daily window publisher to persist the same truthful observation statuses
-- already supported by daily_window_candidates and collection_commit_window_candidate.
-- Membership, order, price, observation, identity and provenance validation remain unchanged.
begin;
set local lock_timeout='10s';

create or replace function public.publish_daily_window_candidates(p_observed_on date,p_snapshot_at timestamptz,p_candidates jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare inserted integer; candidate_count integer; request_groups integer;
begin
  if p_observed_on is null or p_snapshot_at is null or jsonb_typeof(p_candidates) is distinct from 'array'
    or jsonb_array_length(p_candidates)=0 then raise exception 'invalid daily window candidate epoch'; end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) r where
      (r->>'observed_on')::date is distinct from p_observed_on
      or (r->>'snapshot_at')::timestamptz is distinct from p_snapshot_at
      or coalesce((r->>'contract_version')::integer,0)<>1
      or coalesce(r->>'origin','')!~'^[A-Z]{3}$' or coalesce(r->>'dest','')!~'^[A-Z]{3}$'
      or coalesce(r->>'destination_id','')=''
      or coalesce(r->>'flight_type','') not in ('direct','any')
      or coalesce(r->>'window_kind','') not in ('weekend','holiday')
      or (r->>'market') is distinct from public.aviasales_market_for_origin(r->>'origin')
      or r->>'departure_at' is null or r->>'return_at' is null or r->>'position' is null
      or (r->>'departure_at')::date<p_observed_on+10
      or (r->>'departure_at')::date>(p_observed_on+interval '4 months')::date
      or (r->>'return_at')::date<=(r->>'departure_at')::date
      or coalesce((r->>'exact_price')::numeric,0)<=0
      or (r->>'exact_observed_at')::timestamptz is null
      or coalesce(r->>'refresh_status','') not in ('fresh','unavailable','failed')
      or jsonb_typeof(r->'region_codes') is distinct from 'array')
    then raise exception 'invalid daily window candidate row'; end if;
  if exists(select 1 from jsonb_array_elements(p_candidates) r,jsonb_array_elements_text(r->'region_codes') region
      where region is null or region!~'^[A-Z]{2}(-[A-Z0-9]{1,3})?$') then raise exception 'invalid daily window region'; end if;
  perform pg_advisory_xact_lock(hashtext('daily-window-candidates:'||p_observed_on::text));
  insert into public.daily_window_candidate_epochs(observed_on,snapshot_at,contract_version,candidate_rows,exact_request_groups)
    select p_observed_on,p_snapshot_at,1,jsonb_array_length(p_candidates),count(distinct concat_ws('|',r->>'origin',r->>'dest',r->>'departure_at',r->>'return_at'))
    from jsonb_array_elements(p_candidates) r on conflict(observed_on) do nothing;
  get diagnostics inserted=row_count;if inserted=0 then return false;end if;
  insert into public.daily_window_candidates(observed_on,snapshot_at,origin,market,flight_type,region_codes,window_kind,
    departure_at,return_at,position,dest,destination_id,exact_price,currency,transfers,airline,exact_observed_at,
    refresh_status,refresh_checked_at,last_error_kind,price_source)
  select observed_on,snapshot_at,origin,market,flight_type,region_codes,window_kind,departure_at,return_at,position,dest,
    destination_id,exact_price,currency,transfers,airline,exact_observed_at,refresh_status,refresh_checked_at,last_error_kind,price_source
  from jsonb_populate_recordset(null::public.daily_window_candidates,p_candidates);
  get diagnostics candidate_count=row_count;
  select count(distinct concat_ws('|',origin,dest,departure_at,return_at)) into request_groups
    from public.daily_window_candidates where snapshot_at=p_snapshot_at;
  if candidate_count<>jsonb_array_length(p_candidates) or request_groups<1 then raise exception 'incomplete daily window publication';end if;
  if exists(select 1 from public.daily_window_candidates where snapshot_at=p_snapshot_at
      group by origin,flight_type,departure_at,return_at
      having min(position)<>1 or max(position)<>count(*) or count(*)<>count(distinct destination_id))
    then raise exception 'invalid candidate ordering';end if;
  update public.daily_window_candidate_epochs set candidate_rows=candidate_count,exact_request_groups=request_groups
    where observed_on=p_observed_on;
  delete from public.daily_window_candidate_epochs where snapshot_at<clock_timestamp()-interval '31 days';
  return true;
end;
$$;

revoke all on function public.publish_daily_window_candidates(date,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.publish_daily_window_candidates(date,timestamptz,jsonb) to service_role;
commit;
notify pgrst,'reload schema';
