-- 20260808130000_destination_photos_access.sql — pin the city-photo access that until now
-- lived ONLY in the Supabase panel, hand-set, reproduced by no migration (see the app repo's
-- docs/LOG.md note: bucket "destinations" publicity and destination_photos read policy were
-- never in code). The app reads with the anon key: it SELECTs destination_photos and resolves
-- images via supabase.storage.from('destinations').getPublicUrl(...), so it needs two things —
-- a readable table and a PUBLIC photo bucket.
--
-- THIS MIGRATION PINS AN ALREADY-LIVE STATE, IT DOES NOT CHANGE IT. Verified 2026-08-08 with the
-- anon key: destination_photos returns rows (SELECT already allowed), and the public object
-- endpoint for bucket "destinations" answers 200 (bucket already public). Applying this to the
-- live database is a no-op — every statement is create-if-not-exists / grant / on-conflict /
-- drop-policy-if-exists, so it neither duplicates nor overwrites what the panel already set.
--
-- ⚠️ COLUMN TYPES NOT VERIFIED against the live table. The panel-created destination_photos was
-- never read back with the SERVICE-ROLE key (anon cannot see column types / pg catalog), so the
-- CREATE TABLE below mirrors what the collector writes (scripts/upload-photos.mjs) and the app
-- reads (src/lib/photos.ts), NOT the exact stored DDL. On the LIVE db this block is inert
-- (`create table if not exists` skips an existing table). When REBUILDING an environment FROM
-- SCRATCH, re-check the types against the real table first — pexels_id in particular may be
-- bigint rather than text — and adjust before relying on this as the source of truth.
--
-- PRICE SNAPSHOTS STAY PRIVATE ON PURPOSE. The other bucket, "price-snapshots", holds gzip-CSV
-- price history written by the collector under the service-role key; the app never reads it. Its
-- public endpoint answers 400 (private) and this migration deliberately does NOT touch it.
--
-- No other storage needs this: the code references only two buckets — "destinations" (must be
-- public, pinned here) and "price-snapshots" (must stay private, left alone).
--
-- ⚠️ APPLY THIS MANUALLY in the Supabase SQL editor if ever rebuilding — same ordering rule as
-- migrations/20260808120000_offers_target_exact.sql. Additive and idempotent.
--
-- Numbering: timestamp form (YYYYMMDDHHMMSS), one continuous sequence shared with the app repo's
-- migrations; numbers are never reused. Sorts after 20260808120000.

-- ── (1) Photo table: readable by anon (same shape as weather_climate / origin_regions) ──
create table if not exists public.destination_photos (
  dest             text    not null,   -- destination IATA
  position         integer not null,   -- 1..N ordering within a destination
  storage_path     text,               -- in-bucket key, e.g. "DAD/4.webp"
  pexels_id        text,               -- ⚠️ type unverified against live table (see header)
  photographer     text,
  photographer_url text,
  pexels_url       text,
  alt              text,
  avg_color        text,               -- hex like '#8899aa' — placeholder fill while loading
  downloaded_at    timestamptz,
  primary key (dest, position)         -- collector upsert onConflict: (dest, position)
);

alter table public.destination_photos enable row level security;

-- Anon (the app) may READ the provenance rows, never write.
grant usage  on schema public                    to anon;
grant select on table public.destination_photos  to anon;

drop policy if exists "anon read destination_photos" on public.destination_photos;
create policy "anon read destination_photos"
  on public.destination_photos
  for select
  to anon
  using (true);

-- ── (2) Photo bucket "destinations": public, so getPublicUrl serves objects without a key ──
insert into storage.buckets (id, name, public)
values ('destinations', 'destinations', true)
on conflict (id) do update set public = true;

-- A public bucket already serves /object/public/... with no policy, but pin an explicit anon
-- read on storage.objects for this bucket (covers access not via the public endpoint). Scoped
-- to "destinations" ONLY — "price-snapshots" is intentionally left private.
drop policy if exists "anon read destinations objects" on storage.objects;
create policy "anon read destinations objects"
  on storage.objects
  for select
  to anon
  using (bucket_id = 'destinations');

-- Without this PostgREST keeps its old schema cache and can 404 a fresh table (PGRST204).
notify pgrst, 'reload schema';
