-- GUARDED ROLLBACK REFERENCE ONLY. Do not run during incident recovery.
-- The exact preceding definition is preserved in:
--   migrations/20260928120000_immutable_daily_roulette_membership.sql
-- Reapplying that definition would restore the stale-checkpoint abort and cannot reconstruct
-- any row deleted by older production behavior. It requires an explicit owner decision.
do $$begin
  raise exception 'rollback blocked: stale-target failure restoration requires explicit owner authorization';
end$$;
