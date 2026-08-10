-- 20260810120000_window_prices.sql — store for the SEPARATE carousel-window price sweep
-- (scripts/fetch-window-prices.mjs). One row = the cheapest real fare for ONE origin→dest on the
-- EXACT dates of a break window (departure = window start, return = window end), per flight_type.
--
-- Deliberately its OWN table, NOT `offers`:
--   • offers carries combo-selection tags (in_cheap_pool, target_nights, target_exact, …) that the
--     main collector owns; upserting window fares there would overwrite them.
--   • the main collector PRUNES offers it did not reconfirm — it could delete our window rows.
-- A separate table keeps the two sweeps from touching each other's data.
--
-- ⚠️ APPLY THIS MANUALLY in the Supabase SQL editor BEFORE the window sweep runs — the collector
-- upserts into public.window_prices and without the table every write fails PGRST205. Same ordering
-- rule as the other migrations.
--
-- The app (anon key) may READ this for the carousel, exactly like prices/offers. The window
-- collector writes it under the SERVICE-ROLE key, which — as the app_errors cleanup proved — does
-- NOT get privileges on a fresh table automatically, so service_role is granted explicitly below.
--
-- Numbering: timestamp form (YYYYMMDDHHMMSS), one continuous sequence shared with the app repo;
-- numbers never reused. Sorts after 20260809120000. Additive and idempotent.

-- ── (1) Table ────────────────────────────────────────────────────────────────
create table if not exists public.window_prices (
  origin       text        not null,          -- home airport IATA
  dest         text        not null,          -- destination IATA
  flight_type  text        not null,          -- 'direct' (non-stop) | 'any' (incl. connections)
  departure_at date        not null,          -- window START (exact)
  return_at    date        not null,          -- window END (exact)
  nights       smallint,                      -- return - departure
  price        integer     not null,          -- EUR, cheapest for these exact dates + type (>0)
  transfers    smallint,                      -- stops of the cheapest offer
  airline      text,
  updated_at   timestamptz not null default now(),
  primary key (origin, dest, flight_type, departure_at, return_at),  -- collector upsert onConflict
  constraint window_prices_flight_type_check check (flight_type in ('direct', 'any')),
  constraint window_prices_price_check       check (price > 0)       -- an empty answer is NEVER stored
);

-- Safety net if the table pre-dates this migration (added nullable; a fresh create above carries
-- the NOT NULLs / checks). Re-assert the checks idempotently (drop-if-exists before add).
alter table public.window_prices add column if not exists nights     smallint;
alter table public.window_prices add column if not exists transfers  smallint;
alter table public.window_prices add column if not exists airline    text;
alter table public.window_prices add column if not exists updated_at timestamptz not null default now();

alter table public.window_prices drop constraint if exists window_prices_flight_type_check;
alter table public.window_prices add  constraint window_prices_flight_type_check check (flight_type in ('direct', 'any'));
alter table public.window_prices drop constraint if exists window_prices_price_check;
alter table public.window_prices add  constraint window_prices_price_check check (price > 0);

-- ── (2) Read path for the app (anon), same as prices/offers ──────────────────
alter table public.window_prices enable row level security;

grant usage  on schema public          to anon;
grant select on table  public.window_prices to anon;

drop policy if exists "anon read window_prices" on public.window_prices;
create policy "anon read window_prices"
  on public.window_prices
  for select
  to anon
  using (true);

-- ── (3) Write path for the window collector (service-role key) ───────────────
-- BYPASSRLS is not enough — a fresh table grants service_role nothing here (see app_errors, 42501).
grant select, insert, update, delete on table public.window_prices to service_role;

-- Make PostgREST pick up the table immediately (without this a fresh table can 404).
notify pgrst, 'reload schema';
