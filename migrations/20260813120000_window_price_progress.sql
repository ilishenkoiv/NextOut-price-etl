-- 20260813120000_window_price_progress.sql — resume marker for the carousel-window price sweep
-- (scripts/fetch-window-prices.mjs). One row = "this origin→dest has been fully swept for the plan
-- of plan_date". Written AFTER the destination's fares are flushed, so its presence means the prices
-- for that (origin, dest) under that plan are already in public.window_prices.
--
-- WHY a separate marker table (approach #1 of two):
--   • window_prices only ever stores a row when a fare was FOUND (price > 0) — an empty answer writes
--     nothing. So the absence of a window_prices row is ambiguous: "not collected yet" vs "collected,
--     no fare exists". This table removes that ambiguity: a (origin, dest, plan_date) row here means
--     the pair was fully processed regardless of how many fares it yielded.
--   • lets a re-run skip (origin, dest) pairs already done for the same plan_date, so a job killed at
--     the 45-min cap can resume instead of restarting the whole airport.
--
-- plan_date = the sweep's planning date (berlinToday() at start of the run). The window SET is
-- derived from it, so the marker is only valid for that exact plan_date; a different day plans a
-- different window set and must re-collect.
--
-- ⚠️ APPLY THIS MANUALLY in the Supabase SQL editor BEFORE the sweep writes progress — without the
-- table the progress upsert fails PGRST205. Same ordering rule as the other migrations.
--
-- Numbering: timestamp form (YYYYMMDDHHMMSS), one continuous sequence shared with the app repo;
-- numbers never reused. Sorts after 20260810120000. Additive and idempotent.

-- ── (1) Table ────────────────────────────────────────────────────────────────
create table if not exists public.window_price_progress (
  origin     text        not null,               -- home airport IATA
  dest       text        not null,               -- destination IATA fully swept for this plan
  plan_date  date        not null,               -- berlinToday() of the run that swept it
  done_at    timestamptz not null default now(), -- when the pair finished (after its fares flushed)
  primary key (origin, dest, plan_date)          -- collector upsert onConflict
);

-- Safety net if the table pre-dates this migration (added nullable, then re-assert default).
alter table public.window_price_progress add column if not exists done_at timestamptz not null default now();

-- ── (2) NO anon access — this is an internal collector marker, not read by the app ───────────────
alter table public.window_price_progress enable row level security;

-- ── (3) Write/read path for the collector (service-role key) only ────────────────────────────────
-- BYPASSRLS is not enough — a fresh table grants service_role nothing here (see app_errors, 42501).
grant select, insert, update, delete on table public.window_price_progress to service_role;

drop policy if exists "service_role all window_price_progress" on public.window_price_progress;
create policy "service_role all window_price_progress"
  on public.window_price_progress
  for all
  to service_role
  using (true)
  with check (true);

-- Make PostgREST pick up the table immediately (without this a fresh table can 404).
notify pgrst, 'reload schema';
