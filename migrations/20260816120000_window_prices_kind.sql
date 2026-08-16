-- 20260816120000_window_prices_kind.sql — tag each window_prices row with the KIND of window that
-- produced the fare, so the carousel can tell the three window types apart:
--   'weekend'        — the exact Fri→Sun long weekend (departure = Fri, return = Sun);
--   'weekend_around' — a corridor trip AROUND a weekend (fetch-window-prices.mjs §weekend-around);
--   'holiday'        — a public-holiday bridge window.
--
-- ADDITIVE + IDEMPOTENT, and existing rows are left ALONE:
--   • the column is nullable with NO default, so adding it does not rewrite or touch any existing
--     row — they simply carry NULL until the collector next re-prices them and stamps the kind;
--   • the CHECK allows NULL (an unknown value never violates a CHECK), so pre-existing NULL rows and
--     the three known kinds all pass; only a genuinely unexpected string is rejected;
--   • `add column if not exists` + `drop constraint if exists` before `add constraint` make the whole
--     migration safe to run more than once (the repo state is not restored, so re-running must be a
--     no-op — see etl/CLAUDE.md).
--
-- ⚠️ APPLY THIS MANUALLY in the Supabase SQL editor BEFORE the next window sweep runs. The collector
-- now writes `window_kind` in its upsert; without this column that write fails PGRST204 (unknown
-- column), exactly like the parent table's own apply-first rule (20260810120000_window_prices.sql).
--
-- Numbering: timestamp form (YYYYMMDDHHMMSS), one continuous sequence shared with the app repo;
-- numbers never reused. Sorts after 20260813120000_window_price_progress.sql.

-- ── Column ───────────────────────────────────────────────────────────────────
-- Nullable, no default: additive, and it never rewrites an existing row.
alter table public.window_prices add column if not exists window_kind text;

-- ── Value guard ──────────────────────────────────────────────────────────────
-- Idempotent (drop-if-exists before add). NULL passes the CHECK, so existing rows are untouched.
alter table public.window_prices drop constraint if exists window_prices_window_kind_check;
alter table public.window_prices add  constraint window_prices_window_kind_check
  check (window_kind in ('weekend', 'weekend_around', 'holiday'));

-- Make PostgREST pick up the new column immediately (otherwise it 204s on the first write to it).
notify pgrst, 'reload schema';
