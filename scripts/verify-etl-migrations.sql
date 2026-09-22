-- DISPOSABLE DATABASE ONLY. Run after all repository migrations in an isolated Supabase/Postgres.
-- psql -v ON_ERROR_STOP=1 "$DISPOSABLE_DATABASE_URL" -f scripts/verify-etl-migrations.sql
-- The outer transaction always rolls back fixture state; assertion failures abort psql.
begin;
do $$ declare owner_id uuid:='00000000-0000-4000-8000-000000000022'; begin
  update public.collection_scheduler_state set owner=owner_id,fence=999,lease_until=clock_timestamp()+interval '1 hour'
    where singleton;
end $$;

select public.collection_commit_main('00000000-0000-4000-8000-000000000022',999,
  '{"origin":"FRA","market":"de","dest":"MAD","month":"2027-01","direct":200,"any_stops":100,
    "direct_observed":true,"any_observed":true,"updated_at":"2026-09-22T12:00:00Z",
    "price_source":{"variants":{"direct":{"sample":"d"},"any":{"sample":"a"}}}}'::jsonb,'[]'::jsonb);
select public.collection_commit_main('00000000-0000-4000-8000-000000000022',999,
  '{"origin":"FRA","market":"de","dest":"MAD","month":"2027-01","direct":90,"any_stops":null,
    "direct_observed":true,"any_observed":true,"updated_at":"2026-09-22T12:01:00Z",
    "price_source":{"variants":{"direct":{"sample":"d2"}}}}'::jsonb,'[]'::jsonb);
do $$ begin
  if not exists(select 1 from public.prices where origin='FRA' and dest='MAD' and month='2027-01'
    and direct=90 and any_stops=100 and price_source->'variants'->'any'->>'sample'='a') then
    raise exception 'main merge erased known any/provenance'; end if;
end $$;

do $$ declare h text[]:=array['2027-01','2027-02','2027-03','2027-04','2027-05','2027-06'];m text;begin
  foreach m in array h loop perform public.collection_record_route_observation(
    '00000000-0000-4000-8000-000000000022',999,1,'FRA','BCN',m,h,false,false);end loop;
  update public.route_price_health set first_confirmed_no_price_at=clock_timestamp()-interval '30 days',
    first_observed_at=clock_timestamp()-interval '31 days' where origin='FRA' and dest='BCN';
  foreach m in array h loop perform public.collection_record_route_observation(
    '00000000-0000-4000-8000-000000000022',999,2,'FRA','BCN',m,h,false,false);end loop;
  if not exists(select 1 from public.route_price_health where origin='FRA' and dest='BCN' and status='dead') then
    raise exception '30-day complete horizon did not become dead';end if;
  perform public.collection_revive_route('00000000-0000-4000-8000-000000000022',999,'FRA','BCN',clock_timestamp());
  if not exists(select 1 from public.route_price_health where origin='FRA' and dest='BCN' and status='active'
    and first_confirmed_no_price_at is null) then raise exception 'positive exact fare did not revive';end if;
end $$;

do $$ begin
  begin perform public.collection_record_route_observation('00000000-0000-4000-8000-000000000022',999,1,
    'FRA','BCN','2027-01',array['2027-01','2027-02','2027-03','2027-04','2027-05','2027-06'],false,false);
    raise exception 'stale pass accepted';exception when others then
      if sqlerrm='stale pass accepted' then raise;end if;end;
  update public.collection_scheduler_state set fence=1000 where singleton;
  begin perform public.collection_revive_route('00000000-0000-4000-8000-000000000022',999,'FRA','BCN',clock_timestamp());
    raise exception 'stale fence accepted';exception when others then
      if sqlerrm='stale fence accepted' then raise;end if;end;
end $$;
rollback;
