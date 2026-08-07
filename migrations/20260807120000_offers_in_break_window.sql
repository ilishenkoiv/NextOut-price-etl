-- 20260807120000_offers_in_break_window.sql — add offers.in_break_window.
--
-- Marks an offer that was kept because its (departure date, nights) falls in a public-holiday
-- bridge or an ordinary weekend window, ON TOP of the cheap-pool / duration-target selection
-- (scripts/fetch-prices.mjs, selectCombo §break-windows). Additive and idempotent.
--
-- ⚠️ APPLY THIS MANUALLY in the Supabase SQL editor BEFORE deploying the collector change. The
-- collector now sends `in_break_window` on every offers upsert; without the column PostgREST
-- rejects the write with PGRST204 ("column not found") and EVERY offers upsert fails — same
-- ordering rule as migrations/20260802120000_public_holidays.sql.
--
-- Numbering: timestamp form (YYYYMMDDHHMMSS), one continuous sequence shared with the app repo's
-- migrations; numbers are never reused. Sorts after 20260802120000.

alter table public.offers
  add column if not exists in_break_window boolean not null default false;

-- Without this PostgREST keeps its old schema cache and rejects the new column (PGRST204).
notify pgrst, 'reload schema';
