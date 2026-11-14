-- OWNER-MANUAL ONLY. This narrows selected-carousel history to the current
-- Berlin day plus a 48-hour recovery window. It never deletes current prices,
-- offers, or window_prices; only complete historical presentation snapshots.
begin;
set local lock_timeout = '10s';

do $$
begin
  if to_regprocedure('public.collection_prune_selected_carousel_revisions()') is null
    or to_regclass('public.selected_price_refresh_control') is null
    or to_regclass('public.daily_origin_window_candidate_revisions') is null
    or to_regclass('public.daily_origin_window_candidate_revision_candidates') is null then
    raise exception 'selected carousel retention contract is missing';
  end if;
  if not exists(
    select 1 from pg_constraint
    where contype = 'f'
      and conrelid = 'public.daily_origin_window_candidate_revision_candidates'::regclass
      and confrelid = 'public.daily_origin_window_candidate_revisions'::regclass
      and confdeltype = 'c'
  ) then
    raise exception 'selected carousel revision cascade is missing';
  end if;
end;
$$;

create or replace function public.collection_prune_selected_carousel_revisions()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_enabled boolean;
  v_today date;
  v_snapshots timestamptz[];
  v_deleted integer := 0;
begin
  perform set_config('lock_timeout', '5s', true);
  select enabled into v_enabled
    from public.selected_price_refresh_control where singleton = true for update;
  if not found then raise exception 'selected carousel writer control is missing'; end if;

  update public.selected_price_refresh_control set enabled = false where singleton = true;
  begin
    v_today := (clock_timestamp() at time zone 'Europe/Berlin')::date;

    -- The app reads only its current Berlin day. A prior-day complete revision stays
    -- available for 48 hours; older complete parents are historical copies only.
    select coalesce(array_agg(r.snapshot_at), '{}'::timestamptz[]) into v_snapshots
      from public.daily_origin_window_candidate_revisions r
      where r.observed_on < v_today
        and r.completed_at < clock_timestamp() - interval '48 hours'
        and r.candidate_rows = (
          select count(*) from public.daily_origin_window_candidate_revision_candidates c
          where c.snapshot_at = r.snapshot_at and c.origin = r.origin
        )
        and r.exact_request_groups = (
          select count(distinct concat_ws('|', c.flight_type, c.departure_at, c.return_at))
          from public.daily_origin_window_candidate_revision_candidates c
          where c.snapshot_at = r.snapshot_at and c.origin = r.origin
        );

    -- Delete only validated parents. The existing cascade removes exactly their copies.
    delete from public.daily_origin_window_candidate_revisions
      where snapshot_at = any(v_snapshots);
    get diagnostics v_deleted = row_count;
  exception when others then
    update public.selected_price_refresh_control set enabled = v_enabled where singleton = true;
    raise;
  end;

  update public.selected_price_refresh_control set enabled = v_enabled where singleton = true;
  return v_deleted;
end;
$$;

revoke all on function public.collection_prune_selected_carousel_revisions() from public, anon, authenticated;
grant execute on function public.collection_prune_selected_carousel_revisions() to service_role;
commit;
notify pgrst, 'reload schema';
