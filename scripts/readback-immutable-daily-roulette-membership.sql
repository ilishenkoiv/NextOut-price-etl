select pg_get_functiondef('public.publish_daily_cheapest_selection(date,timestamptz,jsonb,jsonb,boolean)'::regprocedure);
select pg_get_functiondef('public.collection_commit_roulette(uuid,bigint,jsonb,jsonb)'::regprocedure);
select observed_on,snapshot_at,completed_at from public.daily_cheapest_selection_runs order by observed_on desc limit 10;
select snapshot_at,origin,count(*) rows,min(rank) min_rank,max(rank) max_rank,count(distinct rank) ranks,count(distinct dest) cities
from public.daily_origin_cheapest_pool group by snapshot_at,origin order by snapshot_at desc,origin;
select count(*) historical_replacement_audit_rows from public.roulette_pool_replacements;
