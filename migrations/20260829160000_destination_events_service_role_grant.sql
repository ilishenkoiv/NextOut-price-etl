-- The first production destination_events migration was applied before the ETL write grant was
-- made explicit. Keep this additive/idempotent so the collector can upsert and deactivate rows.
grant usage on schema public to service_role;
grant select, insert, update on table public.destination_events to service_role;

-- End of manual rollout. PostgREST reload is intentionally omitted: this migration changes only
-- grants, and keeping a quoted NOTIFY as the final line made truncated clipboard pastes fail.
