-- 20260820120000_storage_metrics.sql — daily storage-usage log, written by the collector itself.
--
-- WHY: the free Supabase tier caps the DATABASE at 500 MB and file Storage at 1 GB. Nothing measured
-- those sizes over time, so growth was invisible until an audit. This table records ONE snapshot per
-- day so the trend (and the day a table starts to run away) is visible from the data alone.
--
-- One measurement writes several rows sharing the same measured_at:
--   • kind='table'           — one row per public base table: its exact row count and total bytes
--                              (heap + indexes + toast, i.e. pg_total_relation_size);
--   • kind='db_total'        — the whole database size (pg_database_size), row_count NULL;
--   • kind='snapshot_bucket' — the price-snapshots Storage bucket: object count (row_count) and the
--                              summed object bytes.
-- Rows are only ever INSERTED, never updated — the history is the whole point.
--
-- CLOSED to the public/anon key: RLS on, no anon grants, and the collector function is EXECUTE-only
-- for service_role. Only the service-role key (the same secret every other job uses) can write or read.
--
-- Bytes cannot be read through PostgREST/anon (no size endpoint), so the counting lives in a
-- SECURITY DEFINER function that reads pg_catalog + storage.objects and inserts the rows; the daily
-- job just calls it (scripts/collect-storage-metrics.mjs).
--
-- ⚠️ APPLY THIS MANUALLY in the Supabase SQL editor BEFORE enabling the workflow — without the table
-- and function the job no-ops (logs "not applied yet", exits 0) and records nothing.
--
-- Numbering: timestamp form (YYYYMMDDHHMMSS), one continuous sequence shared with the app repo;
-- numbers never reused. Sorts after 20260818120000. Additive and idempotent.

-- ── (1) Table ────────────────────────────────────────────────────────────────
create table if not exists public.storage_metrics (
  id          bigint generated always as identity primary key,
  measured_at timestamptz not null default now(),   -- one value shared by every row of a measurement
  kind        text        not null,                 -- 'table' | 'db_total' | 'snapshot_bucket'
  name        text        not null,                 -- table name | 'DATABASE' | 'price-snapshots'
  row_count   bigint,                               -- table rows | bucket objects | NULL for db_total
  bytes       bigint      not null,                 -- occupied bytes
  constraint storage_metrics_kind_check check (kind in ('table', 'db_total', 'snapshot_bucket'))
);

-- History is queried by time, newest first.
create index if not exists storage_metrics_measured_at_idx on public.storage_metrics (measured_at desc);

-- ── (2) NO public/anon access — internal telemetry, never read by the app ─────
alter table public.storage_metrics enable row level security;

-- BYPASSRLS is not enough — a fresh table grants service_role nothing (see window_price_misses, 42501).
grant select, insert on table public.storage_metrics to service_role;

drop policy if exists "service_role all storage_metrics" on public.storage_metrics;
create policy "service_role all storage_metrics"
  on public.storage_metrics
  for all
  to service_role
  using (true)
  with check (true);

-- ── (3) Collector function — counts everything and inserts one measurement ────
-- SECURITY DEFINER so it runs as the owner (postgres in the SQL editor) and can read every public
-- table, pg_database_size, and storage.objects regardless of the caller's RLS. search_path is pinned
-- (definer-safety); every object below is schema-qualified anyway. Returns the rows it wrote so the
-- caller can print them without a second read.
create or replace function public.collect_storage_metrics()
returns setof public.storage_metrics
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  ts  timestamptz := now();   -- stable within this function's single transaction; ties every row together
  r   record;
  cnt bigint;
begin
  -- One row per public base table: exact row count + total size (heap + indexes + toast).
  for r in
    select c.oid, c.relname
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public'
      and c.relkind = 'r'
    order by c.relname
  loop
    execute format('select count(*) from public.%I', r.relname) into cnt;
    insert into public.storage_metrics (measured_at, kind, name, row_count, bytes)
    values (ts, 'table', r.relname, cnt, pg_total_relation_size(r.oid));
  end loop;

  -- Whole-database size.
  insert into public.storage_metrics (measured_at, kind, name, row_count, bytes)
  values (ts, 'db_total', 'DATABASE', null, pg_database_size(current_database()));

  -- price-snapshots Storage bucket: object count + summed bytes. Guarded in case the storage schema
  -- is absent in some environment — then record a zero row rather than error the whole measurement.
  if to_regclass('storage.objects') is not null then
    insert into public.storage_metrics (measured_at, kind, name, row_count, bytes)
    select ts, 'snapshot_bucket', 'price-snapshots',
           count(*)::bigint,
           coalesce(sum((o.metadata->>'size')::bigint), 0)
    from storage.objects o
    where o.bucket_id = 'price-snapshots';
  else
    insert into public.storage_metrics (measured_at, kind, name, row_count, bytes)
    values (ts, 'snapshot_bucket', 'price-snapshots', 0, 0);
  end if;

  return query
    select sm.* from public.storage_metrics sm where sm.measured_at = ts order by sm.kind, sm.name;
end;
$$;

-- EXECUTE for service_role only — never anon/authenticated (revoke the default PUBLIC grant first).
revoke all on function public.collect_storage_metrics() from public;
grant execute on function public.collect_storage_metrics() to service_role;

-- Make PostgREST pick up the table + function immediately (without this a fresh object can 404).
notify pgrst, 'reload schema';
