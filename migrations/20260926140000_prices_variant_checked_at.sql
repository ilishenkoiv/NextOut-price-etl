-- 20260926140000_prices_variant_checked_at.sql — per-variant freshness timestamps on public.prices.
--
-- Matches SQL already applied manually by the owner (2026-09-26); this migration is idempotent
-- and additive so the repo's migration history stays reproducible from a fresh database.
--
-- SHAPE: two new nullable timestamptz columns, one per flight-type variant already stored on this
-- table (`direct`, `any_stops`) — direct_checked_at, any_checked_at. `updated_at` is untouched and
-- stays NOT NULL (it remains the row's own last-write time; the two new columns record when EACH
-- variant was last genuinely observed, independent of which variant's price the row currently
-- carries). No backfill: existing rows get NULL in both new columns, meaning "not yet re-observed
-- under the new per-variant contract" — not "confirmed no fare", which is a real, later state.
--
-- WRITER: scripts/fetch-prices.mjs's per-route-month upsert. Stamps ONLY a column for a flight
-- type genuinely queried (an ok TravelPayouts response, priced or a real "no fare") THIS run —
-- see scripts/price-variant-timestamps.mjs. A carried-forward price, a failed/refused check, or
-- the untouched sibling variant never gets its column touched (the upsert simply omits that key).
--
-- READER: app's per-variant freshness gate (direct_checked_at/any_checked_at instead of the
-- shared updated_at), per docs/owner/TICKET-PRICE-POLICY-2026-09-24.md. `updated_at` itself is
-- dropped only later, once every reader has switched (see project decision log, 2026-09-26).
--
-- ROLLBACK: alter table public.prices drop column if exists direct_checked_at;
--           alter table public.prices drop column if exists any_checked_at;
begin;

alter table public.prices
  add column if not exists direct_checked_at timestamptz,
  add column if not exists any_checked_at    timestamptz;

commit;
-- Without this PostgREST keeps its old schema cache and rejects the new columns (PGRST204).
notify pgrst, 'reload schema';
