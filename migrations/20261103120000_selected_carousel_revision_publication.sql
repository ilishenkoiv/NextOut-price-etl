-- Owner-manual, OFF-by-default selected-carousel revision publication.  Each revision is a
-- complete per-origin snapshot; it never mutates the prior factual publication or another origin.
begin;
set local lock_timeout='10s';

create table if not exists public.selected_price_refresh_control(
  singleton boolean primary key default true check(singleton), enabled boolean not null default false,
  generation bigint not null default 0 check(generation>=0), main12h_rollback boolean not null default false,
  updated_at timestamptz not null default clock_timestamp()
);
insert into public.selected_price_refresh_control(singleton) values(true) on conflict(singleton) do nothing;
alter table public.selected_price_refresh_control enable row level security;
revoke all on public.selected_price_refresh_control from public,anon,authenticated;
grant select,insert,update,delete on public.selected_price_refresh_control to service_role;

create table if not exists public.daily_origin_window_candidate_revisions(
  observed_on date not null, origin text not null check(origin~'^[A-Z]{3}$'),
  revision integer not null check(revision>0), snapshot_at timestamptz not null,
  contract_version smallint not null default 1 check(contract_version=1),
  candidate_rows integer not null check(candidate_rows>0), exact_request_groups integer not null check(exact_request_groups>0),
  completed_at timestamptz not null default clock_timestamp(), primary key(observed_on,origin,revision), unique(snapshot_at), unique(observed_on,origin,snapshot_at)
);
create table if not exists public.daily_origin_window_candidate_revision_candidates(
  observed_on date not null, origin text not null check(origin~'^[A-Z]{3}$'), snapshot_at timestamptz not null,
  market text not null, flight_type text not null check(flight_type in ('direct','any')), region_codes text[] not null,
  window_kind text not null check(window_kind in ('weekend','holiday')), departure_at date not null, return_at date not null,
  position smallint not null check(position>0), dest text not null check(dest~'^[A-Z]{3}$'), destination_id text not null,
  source_destination_id text not null, exact_price numeric(10,2) not null check(exact_price>0), currency text not null check(currency='EUR'),
  transfers smallint, airline text, exact_observed_at timestamptz not null, refresh_status text not null check(refresh_status in ('fresh','unavailable','failed')),
  refresh_checked_at timestamptz, last_error_kind text, price_source jsonb not null default '{}'::jsonb,
  primary key(snapshot_at,origin,flight_type,departure_at,return_at,position),
  unique(snapshot_at,origin,flight_type,departure_at,return_at,destination_id),
  foreign key(observed_on,origin,snapshot_at) references public.daily_origin_window_candidate_revisions(observed_on,origin,snapshot_at) on delete cascade
);
alter table public.daily_origin_window_candidate_revisions enable row level security;
alter table public.daily_origin_window_candidate_revision_candidates enable row level security;
revoke all on public.daily_origin_window_candidate_revisions,public.daily_origin_window_candidate_revision_candidates from public,anon,authenticated;
grant select on public.daily_origin_window_candidate_revisions,public.daily_origin_window_candidate_revision_candidates to anon,authenticated;
grant select,insert,update,delete on public.daily_origin_window_candidate_revisions,public.daily_origin_window_candidate_revision_candidates to service_role;
create policy daily_origin_window_candidate_revisions_public_read on public.daily_origin_window_candidate_revisions for select to anon,authenticated using(true);
create policy daily_origin_window_candidate_revision_candidates_public_read on public.daily_origin_window_candidate_revision_candidates for select to anon,authenticated using(true);

create or replace function public.collection_commit_selected_carousel(p_ticket jsonb,p_generation bigint,p_result jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
declare v_day date; v_origin text; v_snapshot timestamptz; v_revision integer; v_next timestamptz:=clock_timestamp(); v_rows integer; v_candidate_rows integer; v_request_groups integer;
begin
  if not exists(select 1 from public.selected_price_refresh_control where singleton=true and enabled and not main12h_rollback and generation=p_generation) then return false; end if;
  v_day:=(p_ticket->>'observed_on')::date; v_origin:=p_ticket->>'origin'; v_snapshot:=(p_ticket->>'snapshot_at')::timestamptz;
  if v_day is null or v_origin !~ '^[A-Z]{3}$' or v_snapshot is null or coalesce(p_result->>'status','') not in ('found','confirmed_absent','error','technical','timeout','rate_limit','unconfirmed') then raise exception 'invalid selected carousel revision'; end if;
  perform pg_advisory_xact_lock(hashtext('selected-carousel:'||v_day::text||':'||v_origin));
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
  select coalesce(max(revision),0)+1 into v_revision from public.daily_origin_window_candidate_revisions where observed_on=v_day and origin=v_origin;
  insert into public.daily_origin_window_candidate_revisions(observed_on,origin,revision,snapshot_at,candidate_rows,exact_request_groups)
    select v_day,v_origin,v_revision,v_next,count(*),count(distinct concat_ws('|',flight_type,departure_at,return_at))
    from public.daily_origin_window_candidates where observed_on=v_day and origin=v_origin and snapshot_at=v_snapshot;
  get diagnostics v_rows=row_count; if v_rows=0 then raise exception 'missing base origin carousel publication'; end if;
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
  return true;
end;$$;
revoke all on function public.collection_commit_selected_carousel(jsonb,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.collection_commit_selected_carousel(jsonb,bigint,jsonb) to service_role;
commit;
notify pgrst,'reload schema';
