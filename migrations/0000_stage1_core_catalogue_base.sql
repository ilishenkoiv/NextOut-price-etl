-- Stage-1 clean-PostgreSQL base for the catalogue objects that predate this repository's
-- reviewed migrations.  It is intentionally a clean-DB contract: it does not alter a
-- populated database, copy data, create roles/policies, or install service interfaces.
--
-- Apply this file first, then replay the reviewed migrations that own later functions
-- and extensions.  In particular, collection owner/fence/lease behaviour remains in
-- 20260916140000_collection_scheduler_state.sql and
-- 20260916141000_collection_atomic_writes.sql.

begin;

create table if not exists public.prices (
  origin text not null check (origin ~ '^[A-Z]{3}$'),
  market text check (market is null or market ~ '^[a-z]{2}$'),
  dest text not null check (dest ~ '^[A-Z]{3}$'),
  month text not null check (month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  direct numeric(10,2),
  any_stops numeric(10,2),
  updated_at timestamptz not null default clock_timestamp(),
  price_source jsonb,
  direct_checked_at timestamptz,
  any_checked_at timestamptz,
  constraint prices_pkey primary key (origin, dest, month),
  constraint prices_distinct_route_check check (origin <> dest),
  constraint prices_direct_positive_check check (direct is null or direct > 0),
  constraint prices_any_stops_positive_check check (any_stops is null or any_stops > 0)
);

create table if not exists public.offers (
  origin text not null check (origin ~ '^[A-Z]{3}$'),
  market text check (market is null or market ~ '^[a-z]{2}$'),
  dest text not null check (dest ~ '^[A-Z]{3}$'),
  month text not null check (month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  flight_type text not null check (flight_type in ('any', 'direct')),
  departure_at date not null,
  return_at date not null,
  nights integer not null check (nights > 0),
  price numeric(10,2) not null check (price > 0),
  transfers smallint not null check (transfers >= 0),
  airline text,
  updated_at timestamptz not null default clock_timestamp(),
  in_cheap_pool boolean not null default false,
  target_nights smallint,
  target_exact boolean not null default false,
  target_actual_nights integer,
  in_break_window boolean not null default false,
  price_source jsonb,
  constraint offers_pkey primary key (origin, dest, month, flight_type, departure_at, return_at),
  constraint offers_distinct_route_check check (origin <> dest),
  constraint offers_return_after_departure_check check (return_at > departure_at)
);

create table if not exists public.price_history (
  origin text not null check (origin ~ '^[A-Z]{3}$'),
  market text check (market is null or market ~ '^[a-z]{2}$'),
  dest text not null check (dest ~ '^[A-Z]{3}$'),
  month text not null check (month ~ '^20[0-9]{2}-(0[1-9]|1[0-2])$'),
  direct numeric(10,2),
  any_stops numeric(10,2),
  observed_at timestamptz not null default clock_timestamp(),
  constraint price_history_distinct_route_check check (origin <> dest),
  constraint price_history_direct_positive_check check (direct is null or direct > 0),
  constraint price_history_any_stops_positive_check check (any_stops is null or any_stops > 0)
);

create table if not exists public.daily_origin_cheapest (
  observed_on date not null,
  snapshot_at timestamptz not null,
  origin text not null check (origin ~ '^[A-Z]{3}$'),
  market text check (market is null or market ~ '^[a-z]{2}$'),
  flight_type text not null check (flight_type in ('any', 'direct')),
  dest text not null check (dest ~ '^[A-Z]{3}$'),
  destination_id text,
  price numeric(10,2) not null check (price > 0),
  currency text not null default 'EUR' check (currency = 'EUR'),
  departure_at date not null,
  return_at date,
  transfers smallint not null check (transfers >= 0),
  source_updated_at timestamptz,
  price_source jsonb,
  created_at timestamptz not null default clock_timestamp(),
  constraint daily_origin_cheapest_pkey primary key (snapshot_at, origin, flight_type),
  constraint daily_origin_cheapest_return_after_departure_check check (return_at is null or return_at >= departure_at)
);

create table if not exists public.origin_regions (
  airport text not null check (airport ~ '^[A-Z]{3}$'),
  physical_country text,
  physical_subdivision_code text,
  calendar_country text,
  calendar_subdivision_code text,
  constraint origin_regions_pkey primary key (airport)
);

commit;
