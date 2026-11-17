import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow=readFileSync(new URL('../.github/workflows/collection-coordinator.yml',import.meta.url),'utf8');
const runner=readFileSync(new URL('./run-collection.mjs',import.meta.url),'utf8');
const install=readFileSync(new URL('./install-supabase-external-trigger.sql',import.meta.url),'utf8');

test('external Supabase cron is the sole 30-minute automatic authority',()=>{
  assert.doesNotMatch(workflow,/^\s*schedule:/m);
  assert.match(install,/'\*\/30 \* \* \* \*'/);
  assert.match(install,/jsonb_build_object\('trigger_source', 'supabase-cron'\)/);
  assert.match(workflow,/COLLECTION_TRIGGER_SOURCE: \$\{\{ inputs\.trigger_source \|\| github\.event_name \}\}/);
});

test('new automatic requests coalesce only with automatic requests while manual requests are preserved',()=>{
  assert.match(workflow,/group: \$\{\{ inputs\.trigger_source == 'supabase-cron' && 'nextout-data-collection-auto' \|\| 'nextout-data-collection-manual' \}\}/);
  assert.match(workflow,/queue: single/);
  assert.match(workflow,/cancel-in-progress: false/);
  assert.equal((workflow.match(/group: nextout-data-collection-writer\s*\n\s+queue: max\s*\n\s+cancel-in-progress: false/g)??[]).length,2,
    'the latest automatic request waits behind a manual writer instead of being skipped');
});

test('existing runner remains the sole writer through its stop check and durable lease claim',()=>{
  assert.match(runner,/oldRunnerHasStopped\(previous,\{repository:env\.GITHUB_REPOSITORY,token:env\.GITHUB_TOKEN\}\)/);
  assert.match(runner,/const state=await store\.claim\(previous\?\.owner\?\?null\)\?\?freshScheduleState\(\)/);
  assert.match(runner,/refreshSelectedRoulette\(\{/);
});
