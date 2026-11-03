import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const workflow=readFileSync(new URL('../.github/workflows/collection-coordinator.yml',import.meta.url),'utf8');
const runner=readFileSync(new URL('./run-collection.mjs',import.meta.url),'utf8');
const adapters=readFileSync(new URL('./collection-adapters.mjs',import.meta.url),'utf8');

test('GitHub schedule runs every half hour and maps the owner candidate variable into the selected-only runner',()=>{
  assert.match(workflow,/schedule:\s*\n\s*- cron: '\*\/30 \* \* \* \*'/);
  assert.match(workflow,/SELECTED_PRICE_REFRESH_ONLY: \$\{\{ github\.event_name == 'schedule' && 'true' \|\| 'false' \}\}/);
  assert.match(workflow,/SELECTED_PRICE_REFRESH_CANDIDATE: \$\{\{ vars\.SELECTED_PRICE_REFRESH_CANDIDATE \|\| '' \}\}/);
  assert.match(workflow,/COLLECTION_TRIGGER_SOURCE: \$\{\{ github\.event_name == 'schedule' && 'selected-refresh-schedule'/);
  assert.match(workflow,/workflow_dispatch:/);
});

test('selected-only runner uses the Berlin half-hour gate and bypasses GitHub global-run polling plus broad collection',()=>{
  const start=runner.indexOf('if(selectedRefreshOnly){');
  const end=runner.indexOf('\n    const previous=await store.inspect();\n    // Same normal-intersection',start);
  assert.ok(start>=0&&end>start,'selected-only branch must be isolated before the regular collector');
  const selected=runner.slice(start,end);
  assert.match(selected,/selectedPriceRefreshDue\(dueAt,true\)/);
  assert.match(selected,/adapters\.priority\.step/);
  assert.doesNotMatch(selected,/runDueDailySelection|SequentialSchedule|runBoundedMainAdvance|noOtherActiveRuns/);
  assert.match(runner,/if\(!selectedRefreshOnly&&!await noOtherActiveRuns\(env\)\)/);
});

test('selected-only mode never falls back to legacy priority writes when durable admission is inactive',()=>{
  assert.match(adapters,/const selectedRefreshOnly=process\.env\.SELECTED_PRICE_REFRESH_ONLY==='true'/);
  assert.match(adapters,/if\(selectedRefreshOnly&&!selectedAdmission\.active\)\{\s*r\.total=0;r\.done=true;cp\.phase='weekend'/);
  assert.match(adapters,/if\(selectedRefreshOnly&&!selectedAdmission\.active\)\{\s*w\.total=0;w\.done=true;cp\.weekend=w;cp\.phase='done'/);
});
