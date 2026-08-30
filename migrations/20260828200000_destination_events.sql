-- Six-month exact-date event catalogue. Monthly Wikidata discovery is CC0 and creates candidates;
-- only owner-approved rows whose source content has not changed are visible to the app.
create table if not exists public.destination_events (
  source text not null, source_id text not null, destination_iata text not null,
  name_en text not null, name_de text not null,
  event_type text not null, type_label_en text not null, type_label_de text not null,
  event_start date not null, event_end date not null,
  official_url text, source_url text not null, source_license text not null, source_type_id text,
  latitude double precision, longitude double precision, distance_km numeric(7,1),
  date_confidence text not null default 'exact', needs_translation boolean not null default false,
  content_fingerprint text not null, reviewed_fingerprint text,
  display_name_en text, display_name_de text, display_type_en text, display_type_de text,
  tourist_relevance text, recommended_min_nights smallint, recommended_max_nights smallint,
  approval_status text not null default 'candidate', review_note text, reviewed_at timestamptz,
  active boolean not null default true, last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key (source,source_id,destination_iata,event_start),
  constraint destination_events_iata_check check (destination_iata ~ '^[A-Z]{3}$'),
  constraint destination_events_dates_check check (event_end >= event_start),
  constraint destination_events_type_check check (event_type in ('festival','carnival','fair','music','sports','cultural','public_holiday','other')),
  constraint destination_events_confidence_check check (date_confidence in ('exact','provisional')),
  constraint destination_events_relevance_check check (tourist_relevance is null or tourist_relevance in ('low','medium','high','international')),
  constraint destination_events_approval_check check (approval_status in ('candidate','approved','rejected')),
  constraint destination_events_nights_check check (
    recommended_min_nights is null or (recommended_min_nights between 2 and 14 and recommended_max_nights between recommended_min_nights and 21)
  )
);

create index if not exists destination_events_window on public.destination_events (active,approval_status,event_start,event_end);
create index if not exists destination_events_iata_window on public.destination_events (destination_iata,event_start,event_end);
create index if not exists destination_events_review on public.destination_events (approval_status,active,updated_at desc);

alter table public.destination_events enable row level security;
grant usage on schema public to anon;
grant select on table public.destination_events to anon;
grant select, insert, update on table public.destination_events to service_role;
drop policy if exists "anon read approved destination_events" on public.destination_events;
create policy "anon read approved destination_events" on public.destination_events for select to anon using (
  active=true and approval_status='approved' and reviewed_fingerprint=content_fingerprint
);

create or replace function public.review_destination_event(
  p_source text,p_source_id text,p_destination_iata text,p_event_start date,
  p_status text,p_relevance text,p_min_nights smallint,p_max_nights smallint,
  p_name_en text default null,p_name_de text default null,p_type_en text default null,p_type_de text default null,p_note text default null
) returns public.destination_events language plpgsql security definer set search_path=public as $$
declare out_row public.destination_events;
begin
  if p_status not in ('candidate','approved','rejected') then raise exception 'invalid status'; end if;
  if p_relevance is not null and p_relevance not in ('low','medium','high','international') then raise exception 'invalid relevance'; end if;
  if p_status='approved' and (p_min_nights is null or p_max_nights is null or p_min_nights<2 or p_max_nights<p_min_nights or p_max_nights>21) then
    raise exception 'approved event requires valid 2..21 night range';
  end if;
  update public.destination_events set
    approval_status=p_status,tourist_relevance=p_relevance,recommended_min_nights=p_min_nights,recommended_max_nights=p_max_nights,
    display_name_en=nullif(trim(p_name_en),''),display_name_de=nullif(trim(p_name_de),''),
    display_type_en=nullif(trim(p_type_en),''),display_type_de=nullif(trim(p_type_de),''),review_note=nullif(trim(p_note),''),
    reviewed_fingerprint=case when p_status='approved' then content_fingerprint else null end,reviewed_at=now(),updated_at=now()
  where source=p_source and source_id=p_source_id and destination_iata=p_destination_iata and event_start=p_event_start
  returning * into out_row;
  if out_row.source is null then raise exception 'event not found'; end if;
  return out_row;
end $$;

revoke all on function public.review_destination_event(text,text,text,date,text,text,smallint,smallint,text,text,text,text,text) from public,anon,authenticated;
grant execute on function public.review_destination_event(text,text,text,date,text,text,smallint,smallint,text,text,text,text,text) to service_role;

comment on table public.destination_events is 'Six-month destination-event candidates. Wikidata structured data CC0; app sees only active owner-approved unchanged rows.';
notify pgrst, 'reload schema';
