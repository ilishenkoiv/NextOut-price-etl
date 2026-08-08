-- 20260808120000_offers_target_exact.sql — add offers.target_exact, offers.target_actual_nights.
--
-- Records HOW WELL a kept offer matched its duration target. Until now a target row only carried
-- `target_nights` (migration 0001) and said nothing about whether the offer hit that length
-- exactly or was the ±1-night fallback the selection accepts (scripts/fetch-prices.mjs, selectCombo).
--   target_exact         — the offer's nights EQUAL its target length exactly (not the ±1 fallback).
--   target_actual_nights — the offer's real nights, recorded ONLY for an inexact target match
--                          (target_nights set AND target_exact = false); null otherwise.
-- The PRIMARY KEY (origin,dest,month,flight_type,departure_at,return_at) is UNCHANGED — these are
-- metadata, like in_cheap_pool / target_nights / in_break_window before them. Additive and idempotent:
-- existing fields are untouched and old rows keep their data (defaults: target_exact=false,
-- target_actual_nights=null) until the next collector run re-tags them.
--
-- ⚠️ APPLY THIS MANUALLY in the Supabase SQL editor BEFORE deploying the collector change that
-- writes these columns. The offers upsert will send them on every row; without the columns
-- PostgREST rejects the write with PGRST204 ("column not found") and EVERY offers upsert fails —
-- same ordering rule as migrations/20260807120000_offers_in_break_window.sql.
--
-- Numbering: timestamp form (YYYYMMDDHHMMSS), one continuous sequence shared with the app repo's
-- migrations; numbers are never reused. Sorts after 20260807120000.

alter table public.offers
  add column if not exists target_exact boolean not null default false;

alter table public.offers
  add column if not exists target_actual_nights integer;

-- Without this PostgREST keeps its old schema cache and rejects the new columns (PGRST204).
notify pgrst, 'reload schema';
