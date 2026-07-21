-- 0002_flight_estimates.sql — curated "from €X" flight estimates for destinations where the
-- Travelpayouts cache is empty or effectively empty (<10 dated offers across all origins),
-- so the app can show "Typically from €X (estimate)" instead of a bare "still filling in".
-- Maintained like hotels_segments: static curated, refreshed ~2×/year.
--
-- ⚠️ RUN THIS in the Supabase SQL editor. The app READS with the anon key → RLS select-only.
-- Priority in the app: a live cached price ALWAYS wins over an estimate.
-- TODO-review: values are curated market estimates (round trip from Central Europe, EUR);
-- review before each season refresh. Coverage snapshot 2026-07-18: 0–9 offers rows per dest.

create table if not exists public.flight_estimates (
  iata           text primary key,
  from_price_eur integer not null check (from_price_eur > 0),
  note           text,
  updated_at     timestamptz not null default now()
);

alter table public.flight_estimates enable row level security;

-- Anon may READ estimates (the app shows them), never write.
grant usage  on schema public                    to anon;
grant select on table public.flight_estimates    to anon;

drop policy if exists "anon read flight_estimates" on public.flight_estimates;
create policy "anon read flight_estimates"
  on public.flight_estimates
  for select
  to anon
  using (true);

-- Seed: every stops=1 destination with <10 dated offers in the cache (2026-07-18).
-- The 8 new East-Asia routes get live prices from the next ETL run — these are stopgaps;
-- a live price always takes priority in the app.
insert into public.flight_estimates (iata, from_price_eur, note, updated_at) values
  ('PEK', 480, 'Beijing — new route, stopgap until ETL collects', now()),
  ('PVG', 520, 'Shanghai — new route, stopgap until ETL collects', now()),
  ('CAN', 500, 'Guangzhou — new route, stopgap until ETL collects', now()),
  ('TFU', 540, 'Chengdu — new route, stopgap until ETL collects', now()),
  ('CTS', 650, 'Sapporo — new route, stopgap until ETL collects', now()),
  ('FUK', 620, 'Fukuoka — new route, stopgap until ETL collects', now()),
  ('PUS', 560, 'Busan — new route, stopgap until ETL collects', now()),
  ('CJU', 640, 'Jeju — new route, stopgap until ETL collects', now()),
  ('BRN', 85,  'Bern/Interlaken area — chronically thin cache (2 offers)', now()),
  ('GOI', 470, 'Goa — chronically thin cache (1 offer)', now()),
  ('CTG', 620, 'Cartagena — chronically thin cache (2 offers)', now()),
  ('MCT', 480, 'Muscat — chronically thin cache (5 offers)', now()),
  ('AQJ', 380, 'Aqaba — chronically thin cache (1 offer)', now()),
  ('CNX', 620, 'Chiang Mai — chronically thin cache (3 offers)', now()),
  ('LGK', 680, 'Langkawi — chronically thin cache (1 offer)', now())
on conflict (iata) do update set
  from_price_eur = excluded.from_price_eur,
  note = excluded.note,
  updated_at = excluded.updated_at;

notify pgrst, 'reload schema';
