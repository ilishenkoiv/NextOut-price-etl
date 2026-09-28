import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./refresh-roulette-prices.mjs', import.meta.url), 'utf8');

test('priority-0 roulette recheck is resumable and yields before changing the next ticket', () => {
  assert.match(source, /roulette_price_refresh_checkpoint/);
  assert.match(source, /result\.status === 'yielded'/);
  assert.match(source, /await saveCheckpoint\(supabase, snapshotAt, ticketKey\(ticket\)\)/);
  assert.match(source, /setInterval\(async \(\) =>/);
  assert.match(source, /ownWorkflowName:REFRESH_WORKFLOW_NAME/);
  assert.match(source, /REFRESH_WORKFLOW_NAME = process\.env\.REFRESH_WORKFLOW_NAME \|\| ROULETTE_REFRESH_WORKFLOW/);
});

test('price-only refresh synchronizes exact pool fields and never deletes factual rows', () => {
  assert.match(source, /daily_origin_cheapest_pool'\)\.update\(poolPatch\)/);
  assert.doesNotMatch(source, /daily_origin_cheapest_pool'\)\.(?:insert|upsert|delete)/);
  assert.doesNotMatch(source, /daily_origin_cheapest'\)\.(?:insert|upsert|update|delete)/);
  assert.match(source, /from\('offers'\)\.update/);
  assert.doesNotMatch(source, /from\('offers'\)\.delete/);
});
