-- Two immutable daily epochs with up to ten cheapest real offers per origin/mode.
-- Additive: daily_origin_cheapest remains the rank-1 compatibility read model.
create table if not exists public.daily_origin_cheapest_pool (
  observed_on date not null,
  snapshot_at timestamptz not null,
  origin text not null check (origin ~ '^[A-Z]{3}$'),
  flight_type text not null check (flight_type in ('any', 'direct')),
  rank smallint not null check (rank between 1 and 10),
  dest text not null check (dest ~ '^[A-Z]{3}$'),
  price numeric(10,2) not null check (price > 0),
  currency text not null default 'EUR' check (currency = 'EUR'),
  departure_at date not null,
  return_at date,
  transfers smallint not null check (transfers >= 0),
  source_updated_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (snapshot_at, origin, flight_type, rank),
  check (return_at is null or return_at >= departure_at)
);

create index if not exists daily_origin_cheapest_pool_origin_snapshot_idx
  on public.daily_origin_cheapest_pool (origin, snapshot_at desc, rank);
create index if not exists daily_origin_cheapest_pool_retention_idx
  on public.daily_origin_cheapest_pool (snapshot_at);

alter table public.daily_origin_cheapest_pool enable row level security;
revoke all on table public.daily_origin_cheapest_pool from anon, authenticated;
grant select on table public.daily_origin_cheapest_pool to anon, authenticated;
grant select, insert, delete on table public.daily_origin_cheapest_pool to service_role;

drop policy if exists daily_origin_cheapest_pool_public_read on public.daily_origin_cheapest_pool;
create policy daily_origin_cheapest_pool_public_read
  on public.daily_origin_cheapest_pool for select to anon, authenticated using (true);

comment on table public.daily_origin_cheapest_pool is
  'Up to ten deterministic cheapest real future offers per successful snapshot epoch and origin/flight_type.';
