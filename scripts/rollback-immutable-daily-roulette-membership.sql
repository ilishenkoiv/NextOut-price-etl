-- Contract rollback reference only; do not run as an operational data rollback.
-- The immediately preceding deployed definitions are preserved verbatim in:
--   migrations/20260922122500_daily_cheapest_selection.sql
--   migrations/20260924070000_roulette_pool_found_sync.sql
-- Reapplying those CREATE OR REPLACE definitions would restore destructive force/replacement
-- behavior and therefore requires an explicit owner decision reversing immutable membership.
-- No deleted historical row can be reconstructed by a function-definition rollback.
do $$begin
  raise exception 'rollback blocked: restoring targeted replacement requires explicit owner authorization';
end$$;
