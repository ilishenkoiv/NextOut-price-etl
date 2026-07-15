-- offers: combo-selection tags for the min-nights-by-distance collection.
--   in_cheap_pool  — this offer is one of the N cheapest (any length) for its route-month+flight_type.
--   target_nights  — if kept as the cheapest offer for a target duration (3/5/7/10/14), that target; else null.
-- The PRIMARY KEY (origin,dest,month,flight_type,departure_at,return_at) is UNCHANGED — these are metadata.
--
-- ⚠️ RUN THIS in Supabase BEFORE deploying the updated fetch-prices.mjs: its offers upsert now writes
-- these two columns, and an upsert to a non-existent column fails. Existing rows get the defaults
-- (in_cheap_pool=false, target_nights=null) until the next collector run re-tags them.

alter table public.offers add column if not exists in_cheap_pool boolean not null default false;
alter table public.offers add column if not exists target_nights smallint;
