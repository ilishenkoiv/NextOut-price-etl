-- Apply before deploying new ETL writers or app readers. Existing feedback RPC remains available.
begin;
alter table public.prices add column if not exists price_source jsonb;
alter table public.offers add column if not exists price_source jsonb;
alter table public.window_prices add column if not exists price_source jsonb;
alter table public.daily_origin_cheapest add column if not exists price_source jsonb;
alter table public.daily_origin_cheapest_pool add column if not exists price_source jsonb;

alter table public.flight_price_feedback add column if not exists price_accuracy text;
alter table public.flight_price_feedback add column if not exists shown_source jsonb;
alter table public.flight_price_feedback add column if not exists handoff_at timestamptz;
alter table public.flight_price_feedback add column if not exists flight_type text;

create table if not exists public.flight_price_audits (
  feedback_id uuid primary key references public.flight_price_feedback(id) on delete cascade,
  received_at timestamptz not null,
  feedback jsonb not null,
  receipt_prices jsonb, -- snapshot at receipt, NOT overwritten by later collection
  receipt_status text not null default 'unknown',
  priority smallint not null default 0 check (priority = 0),
  check_status text not null default 'pending'
    check (check_status in ('pending','checking','found','no_result','error','not_requested','legacy')),
  attempts smallint not null default 0,
  next_attempt_at timestamptz not null default now(),
  claim_token uuid,
  lease_until timestamptz,
  checked_at timestamptz,
  checked_price numeric,
  check_detail text,
  check_run_id text
);
create index if not exists flight_price_audits_pending_idx
  on public.flight_price_audits (check_status, next_attempt_at, received_at);
create index if not exists flight_price_audits_received_idx on public.flight_price_audits(received_at, feedback_id);
alter table public.flight_price_audits enable row level security;
revoke all on public.flight_price_audits from public, anon, authenticated;
grant select on public.flight_price_audits to authenticated;
grant select on public.flight_price_audits to service_role;
drop policy if exists "dashboard owner reads flight price audits" on public.flight_price_audits;
create policy "dashboard owner reads flight price audits" on public.flight_price_audits
  for select to authenticated using (public.is_dashboard_admin());

create or replace function public.capture_flight_price_audit()
returns trigger language plpgsql security definer set search_path = public as $$
declare candidates jsonb; snapshot_status text; payload jsonb; eligible boolean;
begin
  payload := jsonb_build_object(
    'booked',new.booked,'price_result',new.price_result,'price_accuracy',new.price_accuracy,
    'origin_iata',new.origin_iata,'destination_iata',new.destination_iata,
    'depart_date',new.depart_date,'return_date',new.return_date,
    'adults',new.adults,'children',new.children,'infants',new.infants,
    'displayed_price_per_person',new.displayed_price_per_person,
    'displayed_flight_total',new.displayed_flight_total,'currency',new.currency,
    'shown_source',new.shown_source,'handoff_at',new.handoff_at,'flight_type',new.flight_type);
  -- Keep comparable direct/any variants distinct; missing flight_type does not silently mean any.
  if new.origin_iata is null or new.depart_date is null or new.return_date is null then
    candidates := '[]'::jsonb; snapshot_status := 'insufficient_context';
  elsif new.shown_source->>'quote_kind' = 'month_min' then
    select coalesce(jsonb_agg(jsonb_build_object('table','prices','month',p.month,
      'direct',p.direct,'any',p.any_stops,'updated_at',p.updated_at,'source',p.price_source)), '[]'::jsonb)
    into candidates from public.prices p where p.origin=new.origin_iata
      and p.dest=new.destination_iata and p.month=to_char(new.depart_date,'YYYY-MM');
    snapshot_status := 'month_min_not_exact';
  else
    select coalesce(jsonb_agg(q.row_data order by q.table_name,q.mode,q.month), '[]'::jsonb)
    into candidates from (
      select 'offers' as table_name,o.flight_type as mode,o.month,
        jsonb_build_object('table','offers','price',o.price,'flight_type',o.flight_type,
          'month',o.month,'updated_at',o.updated_at,'source',o.price_source) as row_data
      from public.offers o where o.origin=new.origin_iata and o.dest=new.destination_iata
        and o.departure_at::date=new.depart_date and o.return_at::date=new.return_date
        and (new.flight_type is null or o.flight_type=new.flight_type) and o.price>0
      union all
      select 'window_prices',w.flight_type,''::text,
        jsonb_build_object('table','window_prices','price',w.price,'flight_type',w.flight_type,
          'updated_at',w.updated_at,'source',w.price_source)
      from public.window_prices w where w.origin=new.origin_iata and w.dest=new.destination_iata
        and w.departure_at::date=new.depart_date and w.return_at::date=new.return_date
        and (new.flight_type is null or w.flight_type=new.flight_type) and w.price>0
    ) q;
    snapshot_status := case when jsonb_array_length(candidates)=0 then 'not_in_cache'
      when new.flight_type is null then 'variant_unknown' else 'captured' end;
  end if;
  eligible := new.price_accuracy in ('matched','different')
    or new.price_result in ('not_right','higher','lower','offer_missing');
  insert into public.flight_price_audits(feedback_id,received_at,feedback,receipt_prices,receipt_status,check_status)
  values(new.id,new.created_at,payload,candidates,snapshot_status,
    case when eligible then 'pending' else 'not_requested' end)
  on conflict(feedback_id) do update set feedback=excluded.feedback,
    receipt_prices=excluded.receipt_prices,receipt_status=excluded.receipt_status,
    check_status=excluded.check_status
    where flight_price_audits.attempts=0 and flight_price_audits.checked_at is null;
  return new;
end $$;
revoke all on function public.capture_flight_price_audit() from public,anon,authenticated;
drop trigger if exists capture_flight_price_audit on public.flight_price_feedback;
create trigger capture_flight_price_audit after insert or update of price_accuracy,shown_source,handoff_at,flight_type
  on public.flight_price_feedback for each row execute function public.capture_flight_price_audit();

-- The original bounded insert/uniqueness checks still own admission. Extra context is optional;
-- it never authorizes writes to prices and contains no additional person identifier.
create or replace function public.submit_flight_price_feedback_v2(
  p_handoff_id text,p_booked boolean,p_price_result text,p_origin_iata text,p_destination_iata text,
  p_depart_date date,p_return_date date,p_adults smallint,p_children smallint,p_infants smallint,
  p_displayed_price_per_person numeric,p_displayed_flight_total numeric,p_currency text,p_context jsonb
) returns boolean language plpgsql security definer set search_path=public as $$
declare ok boolean; source jsonb; handoff_time timestamptz; accuracy text; mode text;
begin
  if p_context is null or jsonb_typeof(p_context)<>'object' or octet_length(p_context::text)>4096 then return false; end if;
  accuracy := p_context->>'accuracy'; mode := p_context->>'flight_type';
  if accuracy is not null and accuracy not in ('matched','different','not_checked') then return false; end if;
  if mode is not null and mode not in ('any','direct') then return false; end if;
  if p_context->>'handoff_at' is not null then
    begin handoff_time := (p_context->>'handoff_at')::timestamptz;
    exception when others then return false; end;
    if handoff_time < now()-interval '7 days' or handoff_time > now()+interval '5 minutes' then return false; end if;
  end if;
  source := p_context->'source';
  if source is not null and source<>'null'::jsonb then
    if jsonb_typeof(source)<>'object' or coalesce(source->>'table','') not in ('offers','prices','window_prices') then return false; end if;
    if source->>'run_id' is not null and source->>'run_id' !~ '^\d{1,25}$' then return false; end if;
    -- Allowlisted public provenance only: do not retain arbitrary fields sent by a modified client.
    source := jsonb_build_object('table',source->>'table','run_id',source->>'run_id',
      'run_attempt',left(source->>'run_attempt',8),'workflow',left(source->>'workflow',100),
      'job',left(source->>'job',100),'started_at',left(source->>'started_at',35),
      'observed_at',left(source->>'observed_at',35),'flight_type',mode,
      'quote_kind',case when source->>'table'='prices' then 'month_min' else 'exact' end);
  else source := null; end if;
  ok := public.submit_flight_price_feedback(p_handoff_id,p_booked,p_price_result,p_origin_iata,
    p_destination_iata,p_depart_date,p_return_date,p_adults,p_children,p_infants,
    p_displayed_price_per_person,p_displayed_flight_total,p_currency);
  if ok then
    update public.flight_price_feedback set price_accuracy=accuracy,shown_source=source,
      handoff_at=handoff_time,flight_type=mode where handoff_id=p_handoff_id;
  end if;
  return ok;
end $$;
revoke all on function public.submit_flight_price_feedback_v2(text,boolean,text,text,text,date,date,smallint,smallint,smallint,numeric,numeric,text,jsonb) from public,authenticated;
grant execute on function public.submit_flight_price_feedback_v2(text,boolean,text,text,text,date,date,smallint,smallint,smallint,numeric,numeric,text,jsonb) to anon;

create or replace function public.claim_flight_price_audit()
returns setof public.flight_price_audits language plpgsql security definer set search_path=public as $$
begin
  -- A runner killed on its third attempt must not leave an eternal "checking" row.
  update public.flight_price_audits set check_status='error',check_detail='worker_lease_expired',
    claim_token=null,lease_until=null
    where check_status='checking' and lease_until<now() and attempts>=3;
  return query with candidate as (
    select feedback_id from public.flight_price_audits
    where attempts<3 and next_attempt_at<=now()
      and (check_status in ('pending','error') or (check_status='checking' and lease_until<now()))
    order by received_at,feedback_id for update skip locked limit 1
  ) update public.flight_price_audits a set check_status='checking',attempts=a.attempts+1,
    claim_token=gen_random_uuid(),lease_until=now()+interval '3 minutes'
    from candidate c where a.feedback_id=c.feedback_id returning a.*;
end $$;

create or replace function public.finish_flight_price_audit(
  p_feedback_id uuid,p_claim_token uuid,p_status text,p_price numeric,p_detail text,p_run_id text
) returns boolean language plpgsql security definer set search_path=public as $$
declare n integer;
begin
  if p_status not in ('found','no_result','error','pending','not_requested') then return false; end if;
  if p_status='found' and (p_price is null or p_price<=0 or p_price>100000) then return false; end if;
  update public.flight_price_audits set check_status=p_status,
    checked_at=case when p_status='pending' then null else clock_timestamp() end,
    checked_price=case when p_status='found' then p_price else null end,
    check_detail=left(p_detail,160),check_run_id=case when p_run_id ~ '^\d{1,25}$' then p_run_id else null end,
    attempts=case when p_status='pending' then greatest(0,attempts-1) else attempts end,
    next_attempt_at=now()+interval '15 minutes',lease_until=null,claim_token=null
    where feedback_id=p_feedback_id and claim_token=p_claim_token and check_status='checking'
      and lease_until>now();
  get diagnostics n=row_count; return n=1;
end $$;
revoke all on function public.claim_flight_price_audit() from public,anon,authenticated;
revoke all on function public.finish_flight_price_audit(uuid,uuid,text,numeric,text,text) from public,anon,authenticated;
grant execute on function public.claim_flight_price_audit() to service_role;
grant execute on function public.finish_flight_price_audit(uuid,uuid,text,numeric,text,text) to service_role;

-- Old feedback is visible but NOT given a fabricated receipt snapshot or retroactive live price.
insert into public.flight_price_audits(feedback_id,received_at,feedback,receipt_status,check_status)
select f.id,f.created_at,jsonb_build_object('booked',f.booked,'price_result',f.price_result,
  'origin_iata',f.origin_iata,'destination_iata',f.destination_iata,'depart_date',f.depart_date,
  'return_date',f.return_date,'adults',f.adults,'children',f.children,'infants',f.infants,
  'displayed_price_per_person',f.displayed_price_per_person,'displayed_flight_total',f.displayed_flight_total,
  'currency',f.currency),'not_recorded','legacy'
from public.flight_price_feedback f on conflict(feedback_id) do nothing;
notify pgrst, 'reload schema';
commit;
