-- OWNER-MANUAL ONLY. Apply after independent review and the target preflight/readback.
-- Retention pauses only the existing selected-carousel writer admission while it removes
-- completed, expired revision snapshots. It neither changes selection nor prices.
begin;
set local lock_timeout = '10s';

do $$
begin
  if to_regprocedure('public.collection_commit_selected_carousel_base_20261106(jsonb,bigint,jsonb)') is null
    or to_regprocedure('public.collection_commit_selected_carousel(jsonb,bigint,jsonb)') is null then
    raise exception 'selected carousel writer contract is missing';
  end if;
  if to_regclass('public.selected_price_refresh_control') is null
    or to_regclass('public.daily_origin_window_candidate_revisions') is null
    or to_regclass('public.daily_origin_window_candidate_revision_candidates') is null then
    raise exception 'selected carousel retention relations are missing';
  end if;
  if not exists(
    select 1 from pg_constraint
    where contype='f'
      and conrelid='public.daily_origin_window_candidate_revision_candidates'::regclass
      and confrelid='public.daily_origin_window_candidate_revisions'::regclass
      and confdeltype='c'
  ) then raise exception 'selected carousel revision cascade is missing'; end if;
end;
$$;

-- Keep the deployed writer body intact behind a private name, then put the same control-row
-- lock in front of every invocation. The public wrapper continues to call this stable name.
alter function public.collection_commit_selected_carousel_base_20261106(jsonb,bigint,jsonb)
  rename to collection_commit_selected_carousel_unlocked_20261111;

create function public.collection_commit_selected_carousel_base_20261106(
  p_ticket jsonb,p_generation bigint,p_result jsonb
) returns boolean language plpgsql security definer set search_path=public as $$
begin
  -- Retention takes this row FOR UPDATE. A writer shares it for its whole transaction, so
  -- retention cannot delete a revision while a selected-carousel write is in progress.
  perform 1 from public.selected_price_refresh_control where singleton=true for share;
  if not found then return false; end if;
  return public.collection_commit_selected_carousel_unlocked_20261111(p_ticket,p_generation,p_result);
end;
$$;

create function public.collection_prune_selected_carousel_revisions()
returns integer language plpgsql security definer set search_path=public as $$
declare
  v_enabled boolean;
  v_snapshots timestamptz[];
  v_deleted integer:=0;
begin
  -- A live writer holds the matching FOR SHARE lock. Fail closed instead of waiting into the
  -- next maintenance unit or deleting against an unknown admission state.
  perform set_config('lock_timeout','5s',true);
  select enabled into v_enabled
    from public.selected_price_refresh_control where singleton=true for update;
  if not found then raise exception 'selected carousel writer control is missing'; end if;

  -- Capture the exact prior state. Admission is restored below on both success and failure.
  update public.selected_price_refresh_control set enabled=false where singleton=true;
  begin
    select coalesce(array_agg(snapshot_at), '{}'::timestamptz[]) into v_snapshots
      from (
        select snapshot_at
          from (
            select r.snapshot_at,r.completed_at,
              row_number() over (
                partition by r.observed_on,r.origin order by r.completed_at desc,r.revision desc
              ) as complete_rank
            from public.daily_origin_window_candidate_revisions r
            where r.completed_at is not null
              and r.candidate_rows=(
                select count(*) from public.daily_origin_window_candidate_revision_candidates c
                where c.snapshot_at=r.snapshot_at and c.origin=r.origin
              )
              and r.exact_request_groups=(
                select count(distinct concat_ws('|',c.flight_type,c.departure_at,c.return_at))
                from public.daily_origin_window_candidate_revision_candidates c
                where c.snapshot_at=r.snapshot_at and c.origin=r.origin
              )
          ) complete_revisions
          where complete_rank>3
            and completed_at<clock_timestamp()-interval '48 hours'
      ) obsolete;

    -- The child relation is ON DELETE CASCADE: retention admits only qualified, expired parents.
    -- Never target a candidate independently of its retained revision parent.
    delete from public.daily_origin_window_candidate_revisions
      where snapshot_at=any(v_snapshots);
    get diagnostics v_deleted=row_count;
  exception when others then
    update public.selected_price_refresh_control set enabled=v_enabled where singleton=true;
    raise;
  end;

  update public.selected_price_refresh_control set enabled=v_enabled where singleton=true;
  return v_deleted;
end;
$$;

revoke all on function public.collection_commit_selected_carousel_base_20261106(jsonb,bigint,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.collection_commit_selected_carousel_unlocked_20261111(jsonb,bigint,jsonb) from public,anon,authenticated,service_role;
revoke all on function public.collection_prune_selected_carousel_revisions() from public,anon,authenticated;
grant execute on function public.collection_prune_selected_carousel_revisions() to service_role;
commit;
notify pgrst, 'reload schema';
