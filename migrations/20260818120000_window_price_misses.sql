-- 20260818120000_window_price_misses.sql — observation log for window sweeps that came back WITHOUT a
-- fare (scripts/fetch-window-prices.mjs). One row = the LAST probe outcome for ONE origin→dest on the
-- EXACT dates of a break window, per flight_type, when that probe produced no storable price.
--
-- WHY a separate miss log:
--   • window_prices only ever stores a row when a fare was FOUND (price > 0). A successful-but-empty
--     answer, an HTTP error, or a network failure all write nothing there — so a missing window_prices
--     row is silent about WHY it is missing. This table records that "why" for the misses, so an empty
--     route can be told apart from a flaky one, without touching the price data.
--   • it is upserted on the SAME 5-part key as window_prices, so a later re-probe UPDATES the miss row
--     (or the fare finally lands in window_prices) instead of piling up one row per attempt.
--
-- outcome:
--   'empty'         — HTTP 200, success, but no offer on the exact window dates (detail stays empty);
--   'http_error'    — non-2xx / unparseable response (detail carries the status or parse note);
--   'network_error' — the request never completed (detail carries the connection error).
--
-- ⚠️ APPLY THIS MANUALLY in the Supabase SQL editor BEFORE the collector writes misses — without the
-- table the upsert fails PGRST205. Same ordering rule as the other migrations.
--
-- Numbering: timestamp form (YYYYMMDDHHMMSS), one continuous sequence shared with the app repo;
-- numbers never reused. Sorts after 20260816120000. Additive and idempotent.

-- ── (1) Table ────────────────────────────────────────────────────────────────
create table if not exists public.window_price_misses (
  origin       text        not null,               -- home airport IATA
  dest         text        not null,               -- destination IATA
  departure_at date        not null,               -- window START (exact)
  return_at    date        not null,               -- window END (exact)
  flight_type  text        not null,               -- 'direct' (non-stop) | 'any' (incl. connections)
  window_kind  text,                               -- 'weekend' | 'weekend_around' | 'holiday' (nullable, as in window_prices)
  outcome      text        not null,               -- why the probe stored no fare (see header)
  detail       text,                               -- error text; empty for 'empty'
  checked_at   timestamptz not null default now(), -- when this probe ran
  primary key (origin, dest, flight_type, departure_at, return_at),  -- collector upsert onConflict
  constraint window_price_misses_flight_type_check check (flight_type in ('direct', 'any')),
  constraint window_price_misses_outcome_check     check (outcome in ('empty', 'http_error', 'network_error'))
);

-- Safety net if the table pre-dates this migration (added nullable; a fresh create above carries the
-- NOT NULLs / checks). Re-assert the checks idempotently (drop-if-exists before add).
alter table public.window_price_misses add column if not exists window_kind text;
alter table public.window_price_misses add column if not exists detail      text;
alter table public.window_price_misses add column if not exists checked_at  timestamptz not null default now();

alter table public.window_price_misses drop constraint if exists window_price_misses_flight_type_check;
alter table public.window_price_misses add  constraint window_price_misses_flight_type_check check (flight_type in ('direct', 'any'));
alter table public.window_price_misses drop constraint if exists window_price_misses_outcome_check;
alter table public.window_price_misses add  constraint window_price_misses_outcome_check check (outcome in ('empty', 'http_error', 'network_error'));

-- ── (2) Cleanup index — sweep old misses by age ──────────────────────────────
create index if not exists window_price_misses_checked_at_idx on public.window_price_misses (checked_at);

-- ── (3) NO anon access — this is an internal collector log, not read by the app ──────────────────
alter table public.window_price_misses enable row level security;

-- ── (4) Write/read path for the collector (service-role key) only ────────────────────────────────
-- BYPASSRLS is not enough — a fresh table grants service_role nothing here (see app_errors, 42501).
grant select, insert, update, delete on table public.window_price_misses to service_role;

drop policy if exists "service_role all window_price_misses" on public.window_price_misses;
create policy "service_role all window_price_misses"
  on public.window_price_misses
  for all
  to service_role
  using (true)
  with check (true);

-- Make PostgREST pick up the table immediately (without this a fresh table can 404).
notify pgrst, 'reload schema';
