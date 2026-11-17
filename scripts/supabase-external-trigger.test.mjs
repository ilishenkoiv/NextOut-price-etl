import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const install=readFileSync(new URL('./install-supabase-external-trigger.sql',import.meta.url),'utf8');
const rollback=readFileSync(new URL('./rollback-supabase-external-trigger.sql',import.meta.url),'utf8');

test('Supabase cron replaces the legacy trigger with one 30-minute coordinator authority',()=>{
  assert.match(install,/nextout-etl-coordinator-dispatch-30m/);
  assert.match(install,/'\*\/30 \* \* \* \*'/);
  assert.match(install,/jobname not in \('nextout-etl-coordinator-dispatch-5m', 'nextout-etl-coordinator-dispatch-30m'\)/);
  assert.match(install,/select cron\.unschedule\(jobid\)\s+from cron\.job\s+where jobname in \('nextout-etl-coordinator-dispatch-5m', 'nextout-etl-coordinator-dispatch-30m'\)/);
  assert.equal((install.match(/nextout-etl-coordinator-dispatch-5m/g)??[]).length,2,'legacy cadence is only preflighted and replaced');
  assert.match(install,/collection-coordinator\.yml\/dispatches/);
  assert.match(install,/jsonb_build_object\('trigger_source', 'supabase-cron'\)/);
  assert.match(install,/vault\.decrypted_secrets/);
  assert.match(install,/where name = 'nextout_github_workflow_dispatch_token'/);
  assert.match(install,/pg_cron/);assert.match(install,/pg_net/);
  assert.doesNotMatch(install,/ghp_|github_pat_/i,'no credential value belongs in source');
  assert.doesNotMatch(install,/TP_TOKEN|collection_commit_/,'Supabase performs no collection work');
});

test('rollback targets only the unique cron job and wrapper',()=>{
  assert.match(rollback,/jobname = 'nextout-etl-coordinator-dispatch-5m'/);
  assert.match(rollback,/cron\.unschedule/);
  assert.match(rollback,/drop function if exists public\.nextout_dispatch_etl_coordinator\(\)/);
  assert.doesNotMatch(rollback,/delete from|truncate|collection_scheduler_state|daily_window|offers/i);
});
