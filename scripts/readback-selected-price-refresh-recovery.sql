-- OWNER-MANUAL READ-ONLY POST-APPLICATION READBACK. Run only after the reviewed migration succeeds.
select jsonb_build_object(
  'control',(
    select jsonb_build_object('enabled',enabled,'generation',generation,'main12h_rollback',main12h_rollback)
    from public.selected_price_refresh_control where singleton
  ),
  'roulette_wrapper',to_regprocedure('public.collection_commit_selected_roulette(uuid,bigint,bigint,jsonb,jsonb)') is not null,
  'roulette_base',to_regprocedure('public.collection_commit_selected_roulette_base_20261106(uuid,bigint,bigint,jsonb,jsonb)') is not null,
  'carousel_wrapper',to_regprocedure('public.collection_commit_selected_carousel(jsonb,bigint,jsonb)') is not null,
  'carousel_base',to_regprocedure('public.collection_commit_selected_carousel_base_20261106(jsonb,bigint,jsonb)') is not null,
  'replacement_ticket_column',exists(
    select 1 from information_schema.columns where table_schema='public' and table_name='roulette_pool_ticket_revisions'
      and column_name='replacement_ticket' and data_type='jsonb'
  ),
  'service_roulette_execute',has_function_privilege('service_role','public.collection_commit_selected_roulette(uuid,bigint,bigint,jsonb,jsonb)','EXECUTE'),
  'service_carousel_execute',has_function_privilege('service_role','public.collection_commit_selected_carousel(jsonb,bigint,jsonb)','EXECUTE'),
  'anon_roulette_execute',has_function_privilege('anon','public.collection_commit_selected_roulette(uuid,bigint,bigint,jsonb,jsonb)','EXECUTE'),
  'anon_carousel_execute',has_function_privilege('anon','public.collection_commit_selected_carousel(jsonb,bigint,jsonb)','EXECUTE'),
  'roulette_definition',pg_get_functiondef('public.collection_commit_selected_roulette(uuid,bigint,bigint,jsonb,jsonb)'::regprocedure),
  'carousel_definition',pg_get_functiondef('public.collection_commit_selected_carousel(jsonb,bigint,jsonb)'::regprocedure)
) as selected_price_refresh_recovery_readback;
