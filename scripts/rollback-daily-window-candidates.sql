-- Recovery only. Keep collection paused and deploy code that does not call these RPCs first.
begin;
set local lock_timeout='10s';
drop function if exists public.collection_commit_window_candidate(uuid,bigint,jsonb,jsonb);
drop function if exists public.publish_daily_window_candidates(date,timestamptz,jsonb);
alter table if exists public.daily_window_candidates rename to daily_window_candidates_rollback_20260922;
alter table if exists public.daily_window_candidate_epochs rename to daily_window_candidate_epochs_rollback_20260922;
commit;
notify pgrst,'reload schema';
