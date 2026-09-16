-- Owner applies manually. Additive private coordinator state only.
begin;
create table if not exists public.collection_scheduler_state (
  singleton boolean primary key default true check (singleton),
  owner uuid,
  run_id text,
  fence bigint not null default 0,
  lease_until timestamptz,
  checkpoint jsonb not null default '{"version":1,"jobs":{},"completedMain":0,"missedFast":0}'::jsonb,
  updated_at timestamptz not null default now()
);
insert into public.collection_scheduler_state(singleton) values(true) on conflict do nothing;
alter table public.collection_scheduler_state enable row level security;
revoke all on public.collection_scheduler_state from public, anon, authenticated;
grant all on public.collection_scheduler_state to service_role;

create or replace function public.collection_state_inspect() returns jsonb
language sql security definer set search_path = public as $$
  select jsonb_build_object('owner',owner,'run_id',run_id,'lease_until',lease_until)
  from public.collection_scheduler_state where singleton;
$$;

create or replace function public.collection_state_claim(p_owner uuid,p_run_id text,p_previous_owner uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare r public.collection_scheduler_state;
begin
  if p_owner is null or p_run_id is null or p_run_id !~ '^[0-9]+$' then raise exception 'invalid runner'; end if;
  select * into r from public.collection_scheduler_state where singleton for update;
  -- The caller must first confirm the old GitHub run is completed. Expiry alone
  -- does not authorize takeover. The explicit old owner is a compare-and-swap.
  if r.owner is not null and not (
    p_previous_owner is not null and r.owner = p_previous_owner
    and r.lease_until < clock_timestamp() - interval '30 seconds'
  ) then return null; end if;
  update public.collection_scheduler_state set owner=p_owner,run_id=p_run_id,
    fence=fence+1,lease_until=clock_timestamp()+interval '3 minutes',updated_at=clock_timestamp()
    where singleton returning * into r;
  return jsonb_build_object('token',r.fence,'state',r.checkpoint);
end;
$$;

create or replace function public.collection_state_renew(p_owner uuid,p_token bigint)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  update public.collection_scheduler_state set lease_until=clock_timestamp()+interval '3 minutes',updated_at=clock_timestamp()
    where singleton and owner=p_owner and fence=p_token and lease_until>clock_timestamp();
  return found;
end;
$$;

create or replace function public.collection_state_save(p_owner uuid,p_token bigint,p_state jsonb)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  if jsonb_typeof(p_state) <> 'object' or p_state->>'version' is distinct from '1'
    or jsonb_typeof(p_state->'jobs') is distinct from 'object' then raise exception 'invalid checkpoint'; end if;
  update public.collection_scheduler_state set checkpoint=p_state,updated_at=clock_timestamp()
    where singleton and owner=p_owner and fence=p_token and lease_until>clock_timestamp();
  return found;
end;
$$;

create or replace function public.collection_state_release(p_owner uuid,p_token bigint)
returns boolean language plpgsql security definer set search_path=public as $$
begin
  update public.collection_scheduler_state set owner=null,run_id=null,lease_until=null,updated_at=clock_timestamp()
    where singleton and owner=p_owner and fence=p_token;
  return found;
end;
$$;
revoke all on function public.collection_state_inspect() from public,anon,authenticated;
revoke all on function public.collection_state_claim(uuid,text,uuid) from public,anon,authenticated;
revoke all on function public.collection_state_renew(uuid,bigint) from public,anon,authenticated;
revoke all on function public.collection_state_save(uuid,bigint,jsonb) from public,anon,authenticated;
revoke all on function public.collection_state_release(uuid,bigint) from public,anon,authenticated;
grant execute on function public.collection_state_inspect() to service_role;
grant execute on function public.collection_state_claim(uuid,text,uuid) to service_role;
grant execute on function public.collection_state_renew(uuid,bigint) to service_role;
grant execute on function public.collection_state_save(uuid,bigint,jsonb) to service_role;
grant execute on function public.collection_state_release(uuid,bigint) to service_role;
commit;
notify pgrst, 'reload schema';
