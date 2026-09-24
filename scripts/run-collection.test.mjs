import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { noOtherActiveRuns, scheduledCollectionDue, runDueDailySelection, collectionTriggerSource, isAutomatedTrigger } from './run-collection.mjs';
import { CYCLE_MS } from './collection-schedule.mjs';

const source = readFileSync(new URL('./run-collection.mjs', import.meta.url), 'utf8');

test('daily selection is a checkpointed coordinator pre-phase, never an end-of-session republish', () => {
  assert.match(source, /^\s*import[^\n]*snapshot-daily-origin-cheapest/m);
  assert.match(source, /^\s*import[^\n]*snapshot-daily-window-candidates/m);
  assert.match(source, /runDueDailySelection\(\{state,store,db,wave,selectionThresholdMinutes\}\)/);
  assert.doesNotMatch(source, /export\s+(?:async\s+)?function\s+(?:publishEndOfSessionPool|shouldPublishEndOfSession)/, 'end-of-session republish is gone');
  assert.doesNotMatch(source, /daily_origin_cheapest_pool'\)/, 'the coordinator does not query/write the pool tables directly');
});

test('scheduled same-cycle work exits as not due, but a new priority cycle or daily selection is due',()=>{
  const instant=Date.parse('2026-09-23T08:00:00Z'),cycle=Math.floor(instant/CYCLE_MS);
  const state={version:1,jobs:{priority:{id:cycle,done:true}},dailySelection:{day:'2026-09-23',rouletteDone:true,windowDone:true}};
  assert.equal(scheduledCollectionDue(state,instant),false);
  assert.equal(scheduledCollectionDue({...state,jobs:{priority:{id:cycle-1,done:true}}},instant),true);
  assert.equal(scheduledCollectionDue({...state,dailySelection:{day:'2026-09-22',rouletteDone:true,windowDone:true}},instant),true);
});

test('Supabase dispatch records narrow provenance and uses the same automated due gate',()=>{
  const env={GITHUB_EVENT_NAME:'workflow_dispatch',COLLECTION_TRIGGER_SOURCE:'supabase-cron'};
  assert.equal(collectionTriggerSource(env),'supabase-cron');assert.equal(isAutomatedTrigger(env),true);
  assert.equal(isAutomatedTrigger({GITHUB_EVENT_NAME:'workflow_dispatch',COLLECTION_TRIGGER_SOURCE:'manual'}),false);
  assert.throws(()=>collectionTriggerSource({COLLECTION_TRIGGER_SOURCE:'unsafe source'}),/Invalid collection trigger source/);
});

test('due daily selection is serialized by the lease and fenced after each checkpoint phase',async()=>{
  const instant=Date.parse('2026-09-23T07:00:00Z'),saved=[];
  const state={version:1,jobs:{priority:{id:1,done:true,completedAt:123,checkpoint:{phase:'done'}}}};
  const store={lease:async()=>true,save:async value=>saved.push(structuredClone(value))};
  const calls=[];
  const result=await runDueDailySelection({state,store,db:{},instant,wave:43,
    publishRoulette:async args=>{calls.push(['roulette',args]);return{rebuilt:true};},
    publishWindows:async args=>{calls.push(['window',args]);return{published:true};}});
  assert.deepEqual(calls.map(c=>c[0]),['roulette','window']);
  assert.equal(result.published,true);assert.equal(state.dailySelection.rouletteDone,true);assert.equal(state.dailySelection.windowDone,true);
  assert.equal(state.jobs.priority.done,false);assert.equal(state.jobs.priority.checkpoint.phase,'roulette');assert.ok(saved.length>=4);
  await runDueDailySelection({state,store,db:{},instant,wave:43,
    publishRoulette:async()=>{throw new Error('already checkpointed');},publishWindows:async()=>{throw new Error('already checkpointed');}});
});

test('daily selection cannot publish after lease loss',async()=>{
  const state={version:1,jobs:{}};const store={lease:async()=>false,save:async()=>{}};
  await assert.rejects(()=>runDueDailySelection({state,store,db:{},instant:Date.parse('2026-09-23T07:00:00Z'),
    publishRoulette:async()=>({rebuilt:true}),publishWindows:async()=>({published:true})}),/lease lost/);
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

test('off-cycle MAIN advance defaults to exactly legacy behavior (OFF_CYCLE_MAIN_MINUTES unset/0 → immediate not_due, no engine)', () => {
  assert.match(source, /const offCycleMinutes=Number\(env\.OFF_CYCLE_MAIN_MINUTES\?\?0\)/);
  assert.match(source, /const stopAt=offCycleMinutes>0\s*\n\s*\?offCycleMainBudget/);
  assert.match(source, /if\(!stopAt\)\{\s*\n\s*console\.log\(JSON\.stringify\(\{event:'collection_not_due'/);
});

test('off-cycle MAIN advance never offers a priority handler and never calls runDueDailySelection', () => {
  const offCycleBlock = source.slice(source.indexOf('OFF_CYCLE_MAIN_MINUTES'), source.indexOf('await runDueDailySelection'));
  assert.match(offCycleBlock, /const \{priority:_priorityAdapter,\.\.\.offCycleHandlers\}=allAdapters/);
  assert.match(offCycleBlock, /handlers:offCycleHandlers/);
  assert.doesNotMatch(offCycleBlock, /runDueDailySelection/);
});

test('off-cycle MAIN advance always computes its stop time from offCycleMainBudget with the exported safety margin', () => {
  assert.match(source, /export const OFF_CYCLE_SAFETY_MARGIN_MS = 90_000/);
  assert.match(source, /safetyMarginMs:OFF_CYCLE_SAFETY_MARGIN_MS/);
});

test('pilot mode shifts the daily-selection due threshold past the night gap, legacy default is unchanged', () => {
  const winterNight = Date.parse('2026-01-15T02:30:00Z'); // 03:30 Europe/Berlin — legacy threshold, exactly at boundary
  assert.equal(scheduledCollectionDue({ version: 1, jobs: {} }, winterNight), true); // no priority job yet → always due regardless
  const state = { version: 1, jobs: { priority: { id: Math.floor(winterNight / CYCLE_MS), done: true } },
    dailySelection: { day: '2026-01-14', rouletteDone: true, windowDone: true } }; // yesterday's selection, not yet re-run today
  assert.equal(scheduledCollectionDue(state, winterNight), true, 'legacy: 03:30 Berlin is due');
  assert.equal(scheduledCollectionDue(state, winterNight, 7 * 60 + 5), false, 'pilot: 03:30 Berlin is inside the night gap, not due yet');
  const morning = Date.parse('2026-01-15T06:05:00Z'); // 07:05 Europe/Berlin
  const morningState = { ...state, jobs: { priority: { id: Math.floor(morning / CYCLE_MS), done: true } } };
  assert.equal(scheduledCollectionDue(morningState, morning, 7 * 60 + 5), true, 'pilot: due once local time reaches 07:05');
});

test('off-cycle MAIN advance session loop is bounded (cannot busy-loop) and stops on idle', () => {
  const offCycleBlock = source.slice(source.indexOf('OFF_CYCLE_MAIN_MINUTES'), source.indexOf('await runDueDailySelection'));
  assert.match(offCycleBlock, /while\(Date\.now\(\)\+5000<stopAt\)\{/);
  assert.match(offCycleBlock, /if\(offCycleResult\.status==='idle'\)break/);
});
