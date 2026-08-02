-- 20260802120000_public_holidays.sql — public-holiday calendar for Germany, Austria and
-- Switzerland. The price collector uses it to know which date windows (bridge days / long
-- weekends around holidays) are worth searching per departure region.
--
-- SHAPE: one row per (holiday × subdivision). Nationwide holidays are stored as a SINGLE row per
-- country (subdivision_code = NULL, level = 'country') — they are NOT exploded across states.
-- Regional/local holidays get one row per subdivision they apply to.
--
-- ⚠️ RUN THIS in the Supabase SQL editor. The app READS with the anon key → RLS grants select only.
-- Writes are done by the yearly refresh job with the service_role key (scripts/fetch-holidays.mjs),
-- which bypasses RLS.
--
-- VOLUME / PAGINATION: ~862 rows for a 2-year window (DE 83, AT 26, CH 753 — Switzerland is
-- granular down to parts of cantons). That sits just under PostgREST's silent 1000-row cap and can
-- cross it as the window widens or CH data grows. ANY full .select() of this table (in the app or
-- here) MUST page with .range() + .order() on the natural key. When the app gains its first reader,
-- add 'public_holidays' to PAGINATED_TABLES in the app repo's src/lib/supabase-pagination.test.ts
-- (that guard requires a live reader to exist, so it can only be added there and then).
--
-- ─────────────────────────────────────────────────────────────────────────────────────────────
-- DATA SOURCE / ATTRIBUTION — REQUIRED BY LICENCE:
--   Holiday data from OpenHolidaysAPI (https://www.openholidaysapi.org), © its contributors,
--   licensed under the Open Database License (ODbL) v1.0
--   (https://opendatacommons.org/licenses/odbl/1-0/). ODbL permits commercial use; attribution
--   is required. The SAME attribution line must ALSO be shown in the app's "About" screen.
-- ─────────────────────────────────────────────────────────────────────────────────────────────

create table if not exists public.public_holidays (
  source_id        text,                        -- OpenHolidaysAPI holiday id; repeats across the
                                                --   subdivisions of one regional holiday (not unique)
  country          text        not null,         -- 'DE' | 'AT' | 'CH'
  subdivision_code text,                         -- source code verbatim: 'DE-BY', 'AT-WI', 'CH-ZH',
                                                --   'DE-BY-AU' (below state); NULL = whole country
  level            text        not null,         -- 'country' | 'state' | 'district'
  date             date        not null,
  name_de          text        not null,         -- German name (source)
  name_en          text        not null,         -- English name (source)
  partial          boolean     not null default false,  -- true = applies to only PART of the named
                                                --   territory (a district code, or a Local scope)
  scope            text        not null,         -- 'National' | 'Regional' | 'Local' (regionalScope)
  type             text        not null,         -- 'Public' | 'Optional' | 'Bank' | 'School' | ...
  updated_at       timestamptz not null default now()
);

-- Natural key. subdivision_code is NULL for nationwide rows, so the uniqueness guard folds NULL to
-- '' — a plain unique constraint would treat every nationwide re-insert as distinct and let
-- duplicates in. The yearly job refreshes by delete-then-insert, so this index is a safety net.
create unique index if not exists public_holidays_natural_key
  on public.public_holidays (country, (coalesce(subdivision_code, '')), date, name_en);

-- Hot path for the collector: "which holidays for country X within date window [a,b]?"
create index if not exists public_holidays_country_date
  on public.public_holidays (country, date);

alter table public.public_holidays enable row level security;

-- Anon (the app) may READ the calendar, never write.
grant usage  on schema public                to anon;
grant select on table public.public_holidays to anon;

drop policy if exists "anon read public_holidays" on public.public_holidays;
create policy "anon read public_holidays"
  on public.public_holidays
  for select
  to anon
  using (true);

-- Without this PostgREST keeps its old schema cache and rejects the new table/columns (PGRST204).
notify pgrst, 'reload schema';
