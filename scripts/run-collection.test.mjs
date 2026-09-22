import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { noOtherActiveRuns } from './run-collection.mjs';

const source = readFileSync(new URL('./run-collection.mjs', import.meta.url), 'utf8');

// Stage 3: the coordinator is NOT a selection owner. The former end-of-session pool republish
// (publishEndOfSessionPool / shouldPublishEndOfSession) is removed, and run-collection must not
// import or call the selection script at all.
test('the coordinator session never performs selection at session end', () => {
  assert.doesNotMatch(source, /^\s*import[^\n]*snapshot-daily-origin-cheapest/m, 'selection module is not imported by the coordinator');
  assert.doesNotMatch(source, /publishSnapshot\s*\(/, 'no selection call remains');
  assert.doesNotMatch(source, /export\s+(?:async\s+)?function\s+(?:publishEndOfSessionPool|shouldPublishEndOfSession)/, 'end-of-session republish is gone');
  assert.doesNotMatch(source, /daily_origin_cheapest_pool'\)/, 'the coordinator does not query/write the pool tables directly');
});

// The coordinator still refuses to start unless it is the only in-progress run — the guard that
// keeps a single fenced collector (and, with the shared concurrency lock, a single selector).
test('noOtherActiveRuns requires GitHub context and a clean in-progress list', async () => {
  assert.equal(await noOtherActiveRuns({}), false, 'missing GitHub context is treated as not-idle');

  const env = { GITHUB_TOKEN: 't', GITHUB_RUN_ID: '100', GITHUB_REPOSITORY: 'acme/nextout' };
  const onlySelf = async () => ({ ok: true, json: async () => ({ workflow_runs: [{ id: 100 }] }) });
  assert.equal(await noOtherActiveRuns(env, onlySelf), true, 'only this run in progress → may start');

  const another = async () => ({ ok: true, json: async () => ({ workflow_runs: [{ id: 100 }, { id: 999 }] }) });
  assert.equal(await noOtherActiveRuns(env, another), false, 'another active run → refuse to start');
});
