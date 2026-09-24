-- 20260924171200_collection_pilot_state.sql — public, read-only pilot/price-freshness contract
-- for the app (carousel AND roulette), per docs/owner/TICKET-PRICE-POLICY-2026-09-24.md and
-- docs/owner/COLLECTION-FINISH-PLAN-2026-09-24.md gate 3. See
-- docs/PILOT-PRICE-METADATA-CONTRACT.md for the full field/timing/permission documentation.
--
-- SHAPE: a single global row (scope='global'). Both fields this contract publishes — whether
-- PRIORITY_MARKET_SCHEDULE=pilot is active, and the approved price-current ceiling — are global
-- product/ops policy values, never per-origin or per-market (the 120-minute ceiling is explicitly
-- "the same during peak, off-peak, and overnight hours" per the owner policy, and the pilot
-- Variable is a single repository-wide switch). A single row keyed by a fixed scope is therefore
-- the correct identity, not a per-origin table — there is exactly one row to read, always.
--
-- WRITER: scripts/pilot-price-metadata.mjs's publishPilotState(), called from run-collection.mjs
-- under the SAME single collection lease/fence as every other coordinator write — no independent
-- writer, no new concurrency surface. Only service_role may write; RLS denies anon insert/update/
-- delete entirely (no policy is created for them, and no anon grant is given beyond select).
--
-- READER: the app, with the anon key, a single unconditional `select * from collection_pilot_state
-- limit 1` (or `.eq('scope','global')`) — never a secret, never a write.
--
-- ROLLBACK: drop policy "anon read collection_pilot_state" on public.collection_pilot_state;
--           drop table public.collection_pilot_state;
--           notify pgrst, 'reload schema';
-- (Safe at any time: the app's contract read is additive — see the app handoff note for how a
-- client must treat a missing/absent row, which this migration does not depend on.)
begin;

create table if not exists public.collection_pilot_state (
  scope              text primary key default 'global' check (scope = 'global'),
  pilot_active       boolean not null,
  price_freshness_ms integer not null check (price_freshness_ms > 0 and price_freshness_ms <= 7200000),
  updated_at         timestamptz not null default clock_timestamp()
);

alter table public.collection_pilot_state enable row level security;

-- Anon (the app) may READ this row, never write it. No insert/update/delete policy exists for
-- anon or authenticated — RLS default-denies those outright; only service_role (which bypasses
-- RLS) can write, and only through publishPilotState()'s upsert.
grant usage  on schema public                        to anon;
grant select on table  public.collection_pilot_state to anon;
revoke insert, update, delete on table public.collection_pilot_state from anon, authenticated, public;
grant select, insert, update on table public.collection_pilot_state to service_role;

drop policy if exists "anon read collection_pilot_state" on public.collection_pilot_state;
create policy "anon read collection_pilot_state"
  on public.collection_pilot_state
  for select
  to anon
  using (true);

commit;
-- Without this PostgREST keeps its old schema cache and rejects the new table/columns (PGRST204).
notify pgrst, 'reload schema';
