-- OWNER-MANUAL READ-ONLY PREFLIGHT. Run this single query before reviewing/applying the migration.
select jsonb_build_object(
  'control',(
    select jsonb_build_object('enabled',enabled,'generation',generation,'main12h_rollback',main12h_rollback)
    from public.selected_price_refresh_control where singleton
  ),
  'roulette_rpc',to_regprocedure('public.collection_commit_selected_roulette(uuid,bigint,bigint,jsonb,jsonb)') is not null,
  'carousel_rpc',to_regprocedure('public.collection_commit_selected_carousel(jsonb,bigint,jsonb)') is not null,
  'roulette_revisions',to_regclass('public.roulette_pool_ticket_revisions') is not null,
  'roulette_revision_identity',(
    select jsonb_agg(column_name order by ordinal_position)
    from information_schema.columns
    where table_schema='public' and table_name='roulette_pool_ticket_revisions'
      and column_name in ('snapshot_at','origin','flight_type','rank','dest','departure_at','return_at','visibility','reason','generation')
  ),
  'roulette_revision_indexes',(
    select jsonb_agg(indexdef order by indexname)
    from pg_indexes where schemaname='public' and tablename='roulette_pool_ticket_revisions'
  ),
  'carousel_revision_indexes',(
    select jsonb_agg(indexdef order by indexname)
    from pg_indexes where schemaname='public' and tablename='daily_origin_window_candidate_revision_candidates'
  ),
  'roulette_definition',pg_get_functiondef('public.collection_commit_selected_roulette(uuid,bigint,bigint,jsonb,jsonb)'::regprocedure),
  'carousel_definition',pg_get_functiondef('public.collection_commit_selected_carousel(jsonb,bigint,jsonb)'::regprocedure)
) as selected_price_refresh_recovery_preflight;
