-- Explicit Aviasales market provenance. Apply before deploying the market-aware ETL writers.
-- Market follows the departure airport and is deliberately independent from holiday-calendar region.
begin;

create or replace function public.aviasales_market_for_origin(p_origin text)
returns text
language sql
immutable
strict
set search_path = ''
as $$
  select case upper(p_origin)
    when 'FRA' then 'de' when 'MUC' then 'de' when 'BER' then 'de'
    when 'DUS' then 'de' when 'HAM' then 'de' when 'STR' then 'de'
    when 'CGN' then 'de' when 'NUE' then 'de' when 'FMM' then 'de'
    when 'HHN' then 'de' when 'NRN' then 'de' when 'DRS' then 'de'
    when 'LEJ' then 'de'
    when 'VIE' then 'at' when 'SZG' then 'at'
    when 'ZRH' then 'ch' when 'GVA' then 'ch' when 'BSL' then 'ch'
    when 'BTS' then 'sk'
    when 'AMS' then 'nl' when 'EIN' then 'nl'
    when 'LHR' then 'gb'
    else null
  end
$$;

revoke all on function public.aviasales_market_for_origin(text) from public, anon, authenticated;
grant execute on function public.aviasales_market_for_origin(text) to service_role;

alter table public.prices add column if not exists market text;
alter table public.offers add column if not exists market text;
alter table public.price_history add column if not exists market text;
alter table public.window_prices add column if not exists market text;
alter table public.window_price_misses add column if not exists market text;
alter table public.daily_origin_cheapest add column if not exists market text;
alter table public.daily_origin_cheapest_pool add column if not exists market text;
alter table public.flight_price_audits add column if not exists market text;

update public.prices set market=public.aviasales_market_for_origin(origin) where market is null;
update public.offers set market=public.aviasales_market_for_origin(origin) where market is null;
update public.price_history set market=public.aviasales_market_for_origin(origin) where market is null;
update public.window_prices set market=public.aviasales_market_for_origin(origin) where market is null;
update public.window_price_misses set market=public.aviasales_market_for_origin(origin) where market is null;
update public.daily_origin_cheapest set market=public.aviasales_market_for_origin(origin) where market is null;
update public.daily_origin_cheapest_pool set market=public.aviasales_market_for_origin(origin) where market is null;
update public.flight_price_audits
set market=public.aviasales_market_for_origin(feedback->>'origin_iata')
where market is null;

alter table public.prices drop constraint if exists prices_market_check;
alter table public.prices add constraint prices_market_check check (market is null or market ~ '^[a-z]{2}$');
alter table public.offers drop constraint if exists offers_market_check;
alter table public.offers add constraint offers_market_check check (market is null or market ~ '^[a-z]{2}$');
alter table public.price_history drop constraint if exists price_history_market_check;
alter table public.price_history add constraint price_history_market_check check (market is null or market ~ '^[a-z]{2}$');
alter table public.window_prices drop constraint if exists window_prices_market_check;
alter table public.window_prices add constraint window_prices_market_check check (market is null or market ~ '^[a-z]{2}$');
alter table public.window_price_misses drop constraint if exists window_price_misses_market_check;
alter table public.window_price_misses add constraint window_price_misses_market_check check (market is null or market ~ '^[a-z]{2}$');
alter table public.daily_origin_cheapest drop constraint if exists daily_origin_cheapest_market_check;
alter table public.daily_origin_cheapest add constraint daily_origin_cheapest_market_check check (market is null or market ~ '^[a-z]{2}$');
alter table public.daily_origin_cheapest_pool drop constraint if exists daily_origin_cheapest_pool_market_check;
alter table public.daily_origin_cheapest_pool add constraint daily_origin_cheapest_pool_market_check check (market is null or market ~ '^[a-z]{2}$');
alter table public.flight_price_audits drop constraint if exists flight_price_audits_market_check;
alter table public.flight_price_audits add constraint flight_price_audits_market_check check (market is null or market ~ '^[a-z]{2}$');

comment on column public.prices.market is 'Aviasales market explicitly requested for this cached fare; derived from departure airport, not holiday calendar.';
comment on column public.offers.market is 'Aviasales market explicitly requested for this offer; derived from departure airport, not holiday calendar.';
comment on column public.price_history.market is 'Aviasales market used when this historical price change was observed.';
comment on column public.window_prices.market is 'Aviasales market explicitly requested for this exact-date fare.';
comment on column public.window_price_misses.market is 'Aviasales market explicitly requested for this unsuccessful exact-date probe.';
comment on column public.daily_origin_cheapest.market is 'Market inherited from the source offer used by this snapshot.';
comment on column public.daily_origin_cheapest_pool.market is 'Market inherited from the source offer used by this roulette snapshot.';
comment on column public.flight_price_audits.market is 'Market used for the provider comparison, derived from feedback origin airport.';

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
    market=coalesce(market,public.aviasales_market_for_origin(feedback->>'origin_iata')),
    attempts=case when p_status='pending' then greatest(0,attempts-1) else attempts end,
    next_attempt_at=now()+interval '15 minutes',lease_until=null,claim_token=null
    where feedback_id=p_feedback_id and claim_token=p_claim_token and check_status='checking'
      and lease_until>now();
  get diagnostics n=row_count; return n=1;
end $$;

revoke all on function public.finish_flight_price_audit(uuid,uuid,text,numeric,text,text) from public,anon,authenticated;
grant execute on function public.finish_flight_price_audit(uuid,uuid,text,numeric,text,text) to service_role;

commit;
notify pgrst, 'reload schema';
