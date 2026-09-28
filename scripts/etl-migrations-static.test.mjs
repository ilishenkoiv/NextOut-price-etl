import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const mainSql=readFileSync(new URL('../migrations/20260922121500_collection_main_variants.sql',import.meta.url),'utf8');
const healthSql=readFileSync(new URL('../migrations/20260922120000_route_price_health.sql',import.meta.url),'utf8');
const immutableSql=readFileSync(new URL('../migrations/20260928120000_immutable_daily_roulette_membership.sql',import.meta.url),'utf8');
const adapters=readFileSync(new URL('./collection-adapters.mjs',import.meta.url),'utf8');

test('main SQL is fenced and merges only positive independently-observed variants',()=>{
  assert.match(mainSql,/owner=p_owner[\s\S]*fence=p_token[\s\S]*lease_until>clock_timestamp\(\)[\s\S]*for update/);
  assert.match(mainSql,/case when direct_seen and p\.direct is not null then p\.direct else old_price\.direct end/);
  assert.match(mainSql,/case when any_seen and p\.any_stops is not null then p\.any_stops else old_price\.any_stops end/);
});

test('route health remains fenced and immediate positive refresh revival stays wired',()=>{
  assert.match(healthSql,/cardinality\(p_horizon\)<>6/);assert.match(healthSql,/collection_revive_route[\s\S]*status='active'/);
  assert.match(adapters,/collection_commit_window[\s\S]*collection_revive_route/);
  assert.match(adapters,/collection_commit_roulette[\s\S]*collection_revive_route/);
});

test('immutable publication validates ten unique contiguous ranks and makes force non-destructive',()=>{
  assert.match(immutableSql,/count\(\*\)<>10/);assert.match(immutableSql,/count\(distinct rank\)<>10/);
  assert.match(immutableSql,/count\(distinct dest\)<>10/);assert.match(immutableSql,/min\(rank\)<>1 or max\(rank\)<>10/);
  assert.match(immutableSql,/if exists\(select 1 from public\.daily_cheapest_selection_runs where observed_on=p_observed_on\) then return false/);
  const publish=immutableSql.slice(immutableSql.indexOf('create or replace function public.publish_daily_cheapest_selection'),
    immutableSql.indexOf('create or replace function public.collection_commit_roulette'));
  assert.doesNotMatch(publish,/delete from public\.daily_origin_cheapest/);
});

test('roulette commit is exact-slot price-only and every non-found payload is a no-op',()=>{
  assert.match(immutableSql,/if \(p_result->>'status'\) is distinct from 'found' then return true/);
  assert.match(immutableSql,/update public\.daily_origin_cheapest_pool set price=r\.price,transfers=r\.transfers/);
  assert.match(immutableSql,/snapshot_at=t\.snapshot_at and origin=t\.origin and flight_type=t\.flight_type and rank=t\.rank/);
  const commit=immutableSql.slice(immutableSql.indexOf('create or replace function public.collection_commit_roulette'));
  assert.doesNotMatch(commit,/roulette_pool_replacements/);assert.doesNotMatch(commit,/delete from public\.(?:offers|daily_origin_cheapest_pool)/);
  assert.doesNotMatch(commit,/p_result->'replacement'|insert into public\.daily_origin_cheapest_pool|delete from public\.offers/);
});

test('readback and guarded rollback references are present',()=>{
  const readback=readFileSync(new URL('./readback-immutable-daily-roulette-membership.sql',import.meta.url),'utf8');
  const rollback=readFileSync(new URL('./rollback-immutable-daily-roulette-membership.sql',import.meta.url),'utf8');
  assert.match(readback,/pg_get_functiondef/);assert.match(readback,/count\(distinct rank\)/);
  assert.match(rollback,/explicit owner authorization/);assert.match(rollback,/20260924070000_roulette_pool_found_sync/);
});
