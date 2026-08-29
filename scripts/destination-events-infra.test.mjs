import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const migration=fs.readFileSync(new URL('../migrations/20260828200000_destination_events.sql',import.meta.url),'utf8');
const workflow=fs.readFileSync(new URL('../.github/workflows/refresh-destination-events.yml',import.meta.url),'utf8');
const collector=fs.readFileSync(new URL('./fetch-destination-events.mjs',import.meta.url),'utf8');

test('migration gates anon reads to active approved unchanged events',()=>{
  assert.match(migration,/create table if not exists public\.destination_events/i);
  assert.match(migration,/active=true and approval_status='approved' and reviewed_fingerprint=content_fingerprint/i);
});

test('collector service role has explicit table access',()=>{
  assert.match(migration,/grant select, insert, update on table public\.destination_events to service_role/i);
});

test('review writes are service-role-only and require a valid nights range',()=>{
  assert.match(migration,/create or replace function public\.review_destination_event/i);
  assert.match(migration,/revoke all on function public\.review_destination_event[\s\S]+from public,anon,authenticated/i);
  assert.match(migration,/grant execute[\s\S]+to service_role/i);
  assert.match(migration,/approved event requires valid 2\.\.21 night range/i);
});

test('workflow is monthly and collector uses a rolling six-month window',()=>{
  assert.match(workflow,/cron: '27 4 2 \* \*'/);
  assert.match(workflow,/timeout-minutes: 90/);
  assert.match(workflow,/WIKIDATA_CONCURRENCY: '3'/);
  assert.match(workflow,/scripts\/fetch-destination-events\.mjs/);
  assert.match(collector,/sixMonthWindow\(\)/);
  assert.match(collector,/mapConcurrent\(list,CONCURRENCY/);
  assert.match(collector,/Migration not applied — safe no-op/);
});
