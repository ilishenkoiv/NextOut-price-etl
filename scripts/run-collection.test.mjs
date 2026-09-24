import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { noOtherActiveRuns, scheduledCollectionDue, runDueDailySelection, collectionTriggerSource, isAutomatedTrigger,
  OFF_CYCLE_SAFETY_MARGIN_MS } from './run-collection.mjs';
import { CYCLE_MS, offCycleMainBudget, nextPriorityDueAt, runBoundedMainAdvance, SequentialSchedule, freshScheduleState } from './collection-schedule.mjs';

const source = readFileSync(new URL('./run-collection.mjs', import.meta.url), 'utf8');

test('daily selection is a checkpointed coordinator pre-phase, never an end-of-session republish', () => {
  assert.match(source, /^\s*import[^\n]*snapshot-daily-origin-cheapest/m);
  assert.match(source, /^\s*import[^\n]*snapshot-daily-window-candidates/m);
  assert.match(source, /runDueDailySelection\(\{state,store,db,wave,selectionThresholdMinutes,pilotMarketSchedule\}\)/);
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

test('morning transition (pilot): sources not fresh yet → no publish, not marked done, next due cycle retries',async()=>{
  const instant=Date.parse('2026-09-24T05:05:00Z'); // 07:05 Berlin — pilot threshold just reached
  const state={version:1,jobs:{priority:{id:1,done:true,completedAt:123,checkpoint:{phase:'done'}}}};
  const store={lease:async()=>true,save:async()=>{}};
  const result=await runDueDailySelection({state,store,db:{},instant,wave:43,pilotMarketSchedule:true,selectionThresholdMinutes:7*60+5,
    publishRoulette:async()=>({rebuilt:false,reason:'sources_not_fresh'}),
    publishWindows:async()=>({published:false,reason:'sources_not_fresh'})});
  assert.equal(result.published,false);
  assert.equal(state.dailySelection.rouletteDone,false,'not marked done — must retry, never treated as today\'s finished selection');
  assert.equal(state.dailySelection.windowDone,false);
  assert.equal(state.dailySelection.completedAt,undefined,'the day is not complete while sources are not fresh');
  assert.ok(state.dailySelection.rouletteSourcesNotFreshAt);
  assert.ok(state.dailySelection.windowSourcesNotFreshAt);
  // priority's checkpoint must NOT be reset to the 'roulette' phase — nothing was actually published.
  assert.equal(state.jobs.priority.done,true);
  assert.equal(state.jobs.priority.checkpoint.phase,'done');
});

test('morning transition (pilot): a later due cycle, once sources ARE fresh, publishes and marks the day done',async()=>{
  const instant=Date.parse('2026-09-24T05:35:00Z'); // 07:35 Berlin, a later due cycle same day
  // Simulates state already carrying the earlier not-ready attempt's markers.
  const state={version:1,jobs:{priority:{id:1,done:true,completedAt:123,checkpoint:{phase:'done'}}},
    dailySelection:{day:'2026-09-24',rouletteDone:false,windowDone:false,startedAt:instant-1800000,rouletteSourcesNotFreshAt:instant-1800000}};
  const store={lease:async()=>true,save:async()=>{}};
  const result=await runDueDailySelection({state,store,db:{},instant,wave:43,pilotMarketSchedule:true,selectionThresholdMinutes:7*60+5,
    publishRoulette:async()=>({rebuilt:true}),publishWindows:async()=>({published:true})});
  assert.equal(result.published,true);
  assert.equal(state.dailySelection.rouletteDone,true);
  assert.equal(state.dailySelection.windowDone,true);
  assert.ok(state.dailySelection.completedAt);
});

test('day boundary: yesterday\'s completed selection does not block today\'s — both roulette and carousel/window rebuild for the new Berlin day',async()=>{
  const instant=Date.parse('2026-09-24T05:00:00Z'); // a new Berlin day, legacy threshold already past
  const state={version:1,jobs:{priority:{id:1,done:true,completedAt:1,checkpoint:{phase:'done'}}},
    dailySelection:{day:'2026-09-23',rouletteDone:true,windowDone:true,completedAt:1,startedAt:1}};
  const store={lease:async()=>true,save:async()=>{}};
  const calls=[];
  const result=await runDueDailySelection({state,store,db:{},instant,wave:43,
    publishRoulette:async args=>{calls.push('roulette');return{rebuilt:true};},
    publishWindows:async args=>{calls.push('window');return{published:true};}});
  assert.equal(state.dailySelection.day,'2026-09-24','the checkpoint moved to the new Berlin day, not reusing yesterday\'s');
  assert.deepEqual(calls,['roulette','window'],'both paths rebuild for the new day — neither is silently skipped as "already done"');
  assert.equal(result.published,true);
  assert.equal(state.dailySelection.rouletteDone,true);assert.equal(state.dailySelection.windowDone,true);
});

test('asymmetric retry: roulette sources fresh and published while window sources are not — only window retries next cycle, roulette is never re-published',async()=>{
  const instant=Date.parse('2026-09-24T05:05:00Z');
  const state={version:1,jobs:{priority:{id:1,done:true,completedAt:1,checkpoint:{phase:'done'}}}};
  const store={lease:async()=>true,save:async()=>{}};
  const calls=[];
  const first=await runDueDailySelection({state,store,db:{},instant,wave:43,pilotMarketSchedule:true,selectionThresholdMinutes:7*60+5,
    publishRoulette:async()=>{calls.push('roulette');return{rebuilt:true};},
    publishWindows:async()=>{calls.push('window');return{published:false,reason:'sources_not_fresh'};}});
  assert.equal(state.dailySelection.rouletteDone,true,'roulette published — done for the day');
  assert.equal(state.dailySelection.windowDone,false,'window not ready — must retry, never marked done from a not-fresh result');
  assert.equal(first.published,true,'the roulette publish alone already counts as progress this cycle');
  const later=Date.parse('2026-09-24T05:35:00Z');
  const second=await runDueDailySelection({state,store,db:{},instant:later,wave:43,pilotMarketSchedule:true,selectionThresholdMinutes:7*60+5,
    publishRoulette:async()=>{calls.push('roulette-again');return{rebuilt:true};},
    publishWindows:async()=>{calls.push('window-again');return{published:true};}});
  assert.deepEqual(calls,['roulette','window','window-again'],'roulette is never re-invoked once done for the day — only the still-pending window path retries');
  assert.equal(second.published,true);
  assert.equal(state.dailySelection.windowDone,true);
  assert.ok(state.dailySelection.completedAt,'the day only completes once BOTH independently-gated paths are done');
});

test('legacy (pilotMarketSchedule unset) never receives a sources_not_fresh reason and behaves exactly as before',async()=>{
  const instant=Date.parse('2026-09-23T02:30:00Z'); // 03:30 Berlin, legacy threshold
  const state={version:1,jobs:{}};
  const store={lease:async()=>true,save:async()=>{}};
  const calls=[];
  const result=await runDueDailySelection({state,store,db:{},instant,wave:0,
    publishRoulette:async args=>{calls.push(args);return{rebuilt:true};},publishWindows:async()=>({published:true})});
  assert.equal(calls[0].pilotMarketSchedule,false);
  assert.equal(result.published,true);
  assert.equal(state.dailySelection.rouletteDone,true);
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

test('pilot state is published under the same claimed lease for both the regular due session and an actual off-cycle attempt — never on the immediate not_due exit', () => {
  assert.match(source, /import\s*\{\s*publishPilotState\s*\}\s*from\s*'\.\/pilot-price-metadata\.mjs'/);
  const notDueExit = source.slice(source.indexOf("if(!stopAt){"), source.indexOf("if(!stopAt){") + 200);
  assert.doesNotMatch(notDueExit, /publishPilotState/, 'the cheap 5-minute not_due heartbeat must not gain a new write');
  const offCycleBlock = source.slice(source.indexOf('OFF_CYCLE_MAIN_MINUTES'), source.indexOf('await runDueDailySelection'));
  assert.match(offCycleBlock, /await publishPilotState\(db,env\)/, 'off-cycle attempts publish too, not just regular due sessions');
  const justBeforeDueSelection = source.slice(0, source.indexOf('await runDueDailySelection({state,store,db,wave,selectionThresholdMinutes,pilotMarketSchedule})')).slice(-200);
  assert.match(justBeforeDueSelection, /await publishPilotState\(db,env\)/, 'the regular due session publishes right before running daily selection');
});

test('off-cycle MAIN advance defaults to exactly legacy behavior (OFF_CYCLE_MAIN_MINUTES unset/0 → immediate not_due, no engine)', () => {
  assert.match(source, /const offCycleMinutes=Number\(env\.OFF_CYCLE_MAIN_MINUTES\?\?0\)/);
  assert.match(source, /const stopAt=offCycleMinutes>0\s*\n\s*\?offCycleMainBudget/);
  assert.match(source, /if\(!stopAt\)\{\s*\n\s*console\.log\(JSON\.stringify\(\{event:'collection_not_due'/);
});

test('off-cycle MAIN advance never offers a priority handler and never calls runDueDailySelection', () => {
  const offCycleBlock = source.slice(source.indexOf('OFF_CYCLE_MAIN_MINUTES'), source.indexOf('await runDueDailySelection'));
  assert.match(offCycleBlock, /const offCycleHandlers=\{main:allAdapters\.main,tail:allAdapters\.tail\}/);
  assert.match(offCycleBlock, /handlers:offCycleHandlers/);
  assert.doesNotMatch(offCycleBlock, /runDueDailySelection/);
});

test('off-cycle MAIN advance offers only main+tail — never fast/maintenance, which would waste a trigger landing on their wall-clock slot', () => {
  const offCycleBlock = source.slice(source.indexOf('OFF_CYCLE_MAIN_MINUTES'), source.indexOf('await runDueDailySelection'));
  assert.doesNotMatch(offCycleBlock, /fast:allAdapters\.fast/);
  assert.doesNotMatch(offCycleBlock, /maintenance:allAdapters\.maintenance/);
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

test('off-cycle MAIN advance delegates its bounded, keep-ticking loop to the shared, unit-tested runBoundedMainAdvance (see collection-schedule.test.mjs for its busy-loop/idle-exit/deadline coverage)', () => {
  const offCycleBlock = source.slice(source.indexOf('OFF_CYCLE_MAIN_MINUTES'), source.indexOf('await runDueDailySelection'));
  assert.match(source, /import\s*\{[^}]*runBoundedMainAdvance[^}]*\}\s*from\s*'\.\/collection-schedule\.mjs'/);
  assert.match(offCycleBlock, /const \{ ?ticks, ?lastStatus ?\} ?= ?await runBoundedMainAdvance\(\{ ?engine, ?stopAt ?\}\)/);
  assert.doesNotMatch(offCycleBlock, /while\(Date\.now\(\)\+5000<stopAt\)/, 'the inline loop was extracted, not duplicated');
});

// The off-cycle MAIN progress-continuation fix (runBoundedMainAdvance waiting out MAIN's own
// short retryAt cooldown instead of ending the session on a same-tick 'idle') reads only the
// MAIN job and `stopAt`/`clock`. It has no market/time-of-day input at all: `offCycleMainBudget`
// is a pure function of `instant` and the two fixed constants below, and `offCycleHandlers` in
// run-collection.mjs unconditionally excludes 'priority' with no branch on PRIORITY_MARKET_SCHEDULE
// (see the two tests above). priority-market-schedule.mjs's peak(19:00-23:00 DACH/18:00-23:00
// other)/daytime(07:00-19:00, 2h cadence)/night(23:00-07:00, MAIN-only) cadence governs only
// which roulette/window tickets a DUE priority cycle refreshes — off-cycle triggers can never run
// priority, so that cadence cannot affect this fix. This test pins that invariant across
// representative peak/day/night instants and both legacy and pilot mode: identical stopAt budget,
// identical MAIN-continuation behavior, in every case.
test('off-cycle MAIN advance and its cooldown-continuation fix are identical at peak/day/night boundaries and under legacy/pilot mode — neither reads market-schedule state',async()=>{
  const instants={
    dachPeak:Date.parse('2026-09-24T17:05:00Z'),   // 19:05 Europe/Berlin — DACH peak start
    daytime:Date.parse('2026-09-24T08:10:00Z'),     // 10:10 Europe/Berlin — 2h daytime cadence
    night:Date.parse('2026-09-24T01:00:00Z'),       // 03:00 Europe/Berlin — night, MAIN-only for priority
  };
  for(const [label,instant] of Object.entries(instants)){
    for(const pilotMarketSchedule of [false,true]){
      // offCycleMainBudget takes no mode flag; assert its result is exactly the pure formula,
      // regardless of which mode this representative instant is evaluated under.
      const stopAt=offCycleMainBudget(instant,{safetyMarginMs:OFF_CYCLE_SAFETY_MARGIN_MS,maxSessionMs:20*60000});
      const expectedCeiling=nextPriorityDueAt(instant)-OFF_CYCLE_SAFETY_MARGIN_MS;
      assert.equal(stopAt,Math.min(expectedCeiling,instant+20*60000),
        `${label}/pilot=${pilotMarketSchedule}: stopAt must equal the pure offCycleMainBudget formula`);
      if(stopAt===null)continue; // too close to the next due cycle at this instant — nothing to advance, consistent in both modes
      // The cooldown-continuation fix itself: same MAIN state, same outcome, independent of mode.
      const state=freshScheduleState();
      state.jobs.main={id:0,planDate:'2026-09-24',checkpoint:{cursor:100,total:5000,wave:43},done:false,startedAt:instant,completedAt:null,retryAt:instant+30_000,activeMs:0};
      let clock=instant;
      const engine=new SequentialSchedule({
        state,clock:()=>clock,lease:async()=>true,save:async s=>{state.jobs=s.jobs;state.frame=s.frame;},
        stopAt,handlers:{main:{maxUnitMs:90_000,step:async({job})=>{clock+=75_000;
          return{status:'progress',checkpoint:{...job.checkpoint,cursor:job.checkpoint.cursor+1}};}}},
      });
      const sleep=async ms=>{clock+=ms;};
      await runBoundedMainAdvance({engine,stopAt,clock:()=>clock,sleep});
      assert.ok(state.jobs.main.checkpoint.cursor>100,
        `${label}/pilot=${pilotMarketSchedule}: MAIN resumed past its cooldown regardless of time-of-day or market-schedule mode`);
    }
  }
});
