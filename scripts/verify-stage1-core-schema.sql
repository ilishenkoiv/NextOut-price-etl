-- Disposable clean-PostgreSQL verification for migrations/0000_stage1_core_catalogue_base.sql.
-- Run only immediately after the base migration in a throwaway database.  It rolls back its
-- probe rows; it neither connects to nor is suitable for a live database.
--
-- This verifies the catalogue base.  Owner/fence/lease behaviour is intentionally NOT copied
-- here: it is owned by the reviewed collection-state and atomic-write migrations listed in the
-- accompanying manifest and requires their non-core prerequisites for an integration proof.

begin;

do $$
declare
  expected_tables text[] := array['prices', 'offers', 'price_history', 'daily_origin_cheapest', 'origin_regions'];
  expected_columns jsonb := jsonb_build_object(
    'prices', jsonb_build_array('origin','market','dest','month','direct','any_stops','updated_at','price_source','direct_checked_at','any_checked_at'),
    'offers', jsonb_build_array('origin','market','dest','month','flight_type','departure_at','return_at','nights','price','transfers','airline','updated_at','in_cheap_pool','target_nights','target_exact','target_actual_nights','in_break_window','price_source'),
    'price_history', jsonb_build_array('origin','market','dest','month','direct','any_stops','observed_at'),
    'daily_origin_cheapest', jsonb_build_array('observed_on','snapshot_at','origin','market','flight_type','dest','destination_id','price','currency','departure_at','return_at','transfers','source_updated_at','price_source','created_at'),
    'origin_regions', jsonb_build_array('airport','physical_country','physical_subdivision_code','calendar_country','calendar_subdivision_code')
  );
  table_name text;
  column_name text;
  actual_key text[];
begin
  foreach table_name in array expected_tables loop
    if to_regclass('public.' || table_name) is null then
      raise exception 'missing required base table public.%', table_name;
    end if;
    if exists (
      select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relname = table_name and c.relrowsecurity
    ) then
      raise exception 'base table public.% unexpectedly enables row-level security', table_name;
    end if;
    for column_name in select jsonb_array_elements_text(expected_columns -> table_name) loop
      if not exists (
        select 1 from pg_attribute a join pg_class c on c.oid = a.attrelid
        join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relname = table_name and a.attname = column_name
          and a.attnum > 0 and not a.attisdropped
      ) then
        raise exception 'missing required column public.%.%', table_name, column_name;
      end if;
    end loop;
  end loop;

  select array_agg(a.attname order by k.ordinality) into actual_key
  from pg_constraint c
  cross join lateral unnest(c.conkey) with ordinality as k(attnum, ordinality)
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
  where c.conrelid = 'public.prices'::regclass and c.contype = 'p';
  if actual_key is distinct from array['origin','dest','month'] then
    raise exception 'prices primary key mismatch: %', actual_key;
  end if;

  select array_agg(a.attname order by k.ordinality) into actual_key
  from pg_constraint c
  cross join lateral unnest(c.conkey) with ordinality as k(attnum, ordinality)
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
  where c.conrelid = 'public.offers'::regclass and c.contype = 'p';
  if actual_key is distinct from array['origin','dest','month','flight_type','departure_at','return_at'] then
    raise exception 'offers primary key mismatch: %', actual_key;
  end if;

  select array_agg(a.attname order by k.ordinality) into actual_key
  from pg_constraint c
  cross join lateral unnest(c.conkey) with ordinality as k(attnum, ordinality)
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
  where c.conrelid = 'public.daily_origin_cheapest'::regclass and c.contype = 'p';
  if actual_key is distinct from array['snapshot_at','origin','flight_type'] then
    raise exception 'daily_origin_cheapest primary key mismatch: %', actual_key;
  end if;

  select array_agg(a.attname order by k.ordinality) into actual_key
  from pg_constraint c
  cross join lateral unnest(c.conkey) with ordinality as k(attnum, ordinality)
  join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
  where c.conrelid = 'public.origin_regions'::regclass and c.contype = 'p';
  if actual_key is distinct from array['airport'] then
    raise exception 'origin_regions primary key mismatch: %', actual_key;
  end if;

  insert into public.prices(origin, market, dest, month, direct, any_stops, price_source)
    values ('FRA', 'de', 'MAD', '2099-01', null, 100.00, '{"verified":true}');
  begin
    insert into public.prices(origin, dest, month, any_stops) values ('FRA', 'MAD', '2099-01', 101.00);
    raise exception 'prices duplicate key was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into public.prices(origin, dest, month, any_stops) values ('fra', 'MAD', '2099-02', 101.00);
    raise exception 'prices accepted a non-IATA origin';
  exception when check_violation then null;
  end;

  insert into public.offers(origin, market, dest, month, flight_type, departure_at, return_at, nights, price, transfers)
    values ('FRA', 'de', 'MAD', '2099-01', 'any', date '2099-01-10', date '2099-01-13', 3, 100.00, 1);
  begin
    insert into public.offers(origin, dest, month, flight_type, departure_at, return_at, nights, price, transfers)
      values ('FRA', 'MAD', '2099-01', 'any', date '2099-01-10', date '2099-01-13', 3, 99.00, 1);
    raise exception 'offers duplicate key was accepted';
  exception when unique_violation then null;
  end;
  begin
    insert into public.offers(origin, dest, month, flight_type, departure_at, return_at, nights, price, transfers)
      values ('FRA', 'MAD', '2099-01', 'any', date '2099-01-13', date '2099-01-10', 3, 99.00, 1);
    raise exception 'offers accepted an inverted date range';
  exception when check_violation then null;
  end;

  insert into public.price_history(origin, market, dest, month, direct, any_stops)
    values ('FRA', 'de', 'MAD', '2099-01', null, 100.00), ('FRA', 'de', 'MAD', '2099-01', null, 100.00);
  if (select count(*) from public.price_history where origin = 'FRA' and dest = 'MAD' and month = '2099-01') <> 2 then
    raise exception 'price_history is not append-capable';
  end if;

  insert into public.daily_origin_cheapest(observed_on, snapshot_at, origin, market, flight_type, dest, price, departure_at, transfers)
    values (date '2099-01-01', timestamptz '2099-01-01 03:30:00+00', 'FRA', 'de', 'any', 'MAD', 100.00, date '2099-01-10', 1);
  begin
    insert into public.daily_origin_cheapest(observed_on, snapshot_at, origin, market, flight_type, dest, price, departure_at, transfers)
      values (date '2099-01-01', timestamptz '2099-01-01 03:30:00+00', 'FRA', 'de', 'any', 'LIS', 101.00, date '2099-01-10', 1);
    raise exception 'daily_origin_cheapest duplicate compatibility slot was accepted';
  exception when unique_violation then null;
  end;

  insert into public.origin_regions(airport, physical_country, physical_subdivision_code, calendar_country, calendar_subdivision_code)
    values ('FRA', 'DE', 'DE-HE', 'DE', 'DE-HE');
  begin
    insert into public.origin_regions(airport) values ('FRA');
    raise exception 'origin_regions duplicate airport was accepted';
  exception when unique_violation then null;
  end;
end;
$$;

rollback;
