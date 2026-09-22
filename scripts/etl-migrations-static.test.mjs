import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSql=readFileSync(new URL('../migrations/20260922121500_collection_main_variants.sql',import.meta.url),'utf8');
const healthSql=readFileSync(new URL('../migrations/20260922120000_route_price_health.sql',import.meta.url),'utf8');
const selectionSql=readFileSync(new URL('../migrations/20260922122500_daily_cheapest_selection.sql',import.meta.url),'utf8');
const replacementSql=readFileSync(new URL('../migrations/20260922130000_roulette_targeted_replacement.sql',import.meta.url),'utf8');
const adapters=readFileSync(new URL('./collection-adapters.mjs',import.meta.url),'utf8');

test('main SQL is fenced and merges only positive independently-observed variants',()=>{
  assert.match(mainSql,/owner=p_owner[\s\S]*fence=p_token[\s\S]*lease_until>clock_timestamp\(\)[\s\S]*for update/);
  assert.match(mainSql,/case when direct_seen and p\.direct is not null then p\.direct else old_price\.direct end/);
  assert.match(mainSql,/case when any_seen and p\.any_stops is not null then p\.any_stops else old_price\.any_stops end/);
  assert.match(mainSql,/old_price\.price_source->'variants'/);
});

test('route-health SQL validates exact six-month horizon, replay/pass order, fence and immediate revival',()=>{
  assert.match(healthSql,/cardinality\(p_horizon\)<>6/);assert.match(healthSql,/count\(distinct m\)[\s\S]*<>6/);
  assert.match(healthSql,/p_pass_id<h\.observation_pass[\s\S]*stale route observation pass/);
  assert.match(healthSql,/for update/);assert.match(healthSql,/not \(p_month=any\(h\.observed_months\)\)/);
  assert.match(healthSql,/collection_revive_route[\s\S]*status='active',first_confirmed_no_price_at=null/);
  assert.match(adapters,/collection_commit_window[\s\S]*collection_revive_route/);
  assert.match(adapters,/collection_commit_roulette[\s\S]*collection_revive_route/);
});

test('daily publication is one atomic epoch: marker lock and both tables share one function transaction',()=>{
  assert.match(selectionSql,/pg_advisory_xact_lock/);assert.match(selectionSql,/on conflict\(observed_on\) do nothing/);
  assert.match(selectionSql,/get diagnostics inserted=row_count[\s\S]*if inserted=0 then return false/);
  assert.match(selectionSql,/insert into public\.daily_origin_cheapest[\s\S]*insert into public\.daily_origin_cheapest_pool/);
  assert.match(selectionSql,/commit;\s*notify pgrst/);
});

test('disposable SQL verification script exists and rolls fixture changes back',()=>{
  const verify=readFileSync(new URL('./verify-etl-migrations.sql',import.meta.url),'utf8');
  assert.match(verify,/DISPOSABLE DATABASE ONLY/);assert.match(verify,/main merge erased known any/);
  assert.match(verify,/stale fence accepted/);assert.match(verify,/rollback;\s*$/);
});

test('confirmed no-result follows one fenced audited replacement path; technical errors do not write',()=>{
  assert.match(replacementSql,/owner=p_owner[\s\S]*fence=p_token[\s\S]*lease_until>clock_timestamp\(\)[\s\S]*for update/);
  assert.match(replacementSql,/\(p_result->>'status'\) is distinct from 'no_result'[\s\S]*return true/);
  assert.match(replacementSql,/t\.flight_type is null[\s\S]*t\.flight_type not in \('any','direct'\)/);
  assert.match(replacementSql,/jsonb_typeof\(p_ticket->'allowed_dests'\) is distinct from 'array'/);
  assert.match(replacementSql,/allowed is null or cardinality\(allowed\)<1/);
  assert.match(replacementSql,/candidate\.flight_type is distinct from t\.flight_type/);
  assert.match(replacementSql,/candidate\.updated_at<clock_timestamp\(\)-interval '30 minutes'/);
  assert.match(replacementSql,/p\.dest=candidate\.dest/);
  assert.match(replacementSql,/delete from public\.daily_origin_cheapest_pool[\s\S]*insert into public\.daily_origin_cheapest_pool/);
  assert.match(replacementSql,/delete from public\.offers[\s\S]*insert into public\.roulette_pool_replacements/);
  assert.match(replacementSql,/outcome in \('replaced','exhausted'\)/);
});

test('real SQL-path regression is transactional and asserts replacement, idempotency boundary and error no-op',()=>{
  const verify=readFileSync(new URL('./verify-roulette-targeted-replacement.sql',import.meta.url),'utf8');
  assert.match(verify,/scheduler is not idle/);assert.match(verify,/targeted replacement assertion failed/);
  assert.match(verify,/historical_rows_removed=2/);assert.match(verify,/targeted replacement idempotency assertion failed/);
  assert.match(verify,/null or missing status changed membership\/offer/);
  assert.match(verify,/missing allowed destinations accepted/);assert.match(verify,/empty allowed destinations accepted/);
  assert.match(verify,/null flight type accepted/);assert.match(verify,/null guard rejection changed membership\/offer/);
  assert.match(verify,/technical error changed membership\/offer/);assert.match(verify,/rollback;\s*$/);
});
