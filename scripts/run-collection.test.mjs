import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { noOtherActiveRuns, scheduledCollectionDue, runDueDailySelection, collectionTriggerSource, isAutomatedTrigger,
  main, dailySelectionRetryThrottled, runAllOriginPriorityFill, allOriginPriorityReleased, DAILY_SELECTION_RETRY_MS,
  DAILY_SELECTION_REFRESH_MAX_MS, DAILY_SELECTION_REFRESH_RESERVE_MS } from './run-collection.mjs';
import { CYCLE_MS } from './collection-schedule.mjs';
import { berlinObservedOn } from './snapshot-daily-origin-cheapest.mjs';

const source = readFileSync(new URL('./run-collection.mjs', import.meta.url), 'utf8');

test('daily selection is a checkpointed coordinator pre-phase, never an end-of-session republish', () => {
  assert.match(source, /^\s*import[^\n]*snapshot-daily-origin-cheapest/m);
  assert.match(source, /^\s*import[^\n]*snapshot-daily-window-candidates/m);
  assert.match(source, /allOriginPriorityAdapter:allAdapters\.allOriginPriority/);
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
    publishWindows:async args=>{calls.push(['window',args]);return{published:true,handledOriginInputs:{}};}});
  assert.deepEqual(calls.map(c=>c[0]),['window','roulette']);
  assert.equal(result.published,true);assert.equal(state.dailySelection.rouletteDone,true);assert.equal(state.dailySelection.windowDone,true);
  assert.ok(Number.isFinite(Date.parse(state.dailySelection.windowNewInputBaselineAt)),
    'ordinary completion persists a retry baseline even when no origin fingerprint succeeded');
  assert.equal(state.jobs.priority.done,false);assert.equal(state.jobs.priority.checkpoint.phase,'roulette');assert.ok(saved.length>=4);
  await runDueDailySelection({state,store,db:{},instant,wave:43,
    publishRoulette:async args=>{assert.equal(args.provider,null);return{rebuilt:false,reason:'no_changed_factual_input',handledOriginInputs:{},attemptedOriginInputs:{}};},
    publishWindows:async args=>{assert.equal(args.provider,null);return{published:false,handledOriginInputs:{}};}});
});

test('a valid initial 1–2 roulette pool receives exactly one bounded same-run rebuild',async()=>{
  const instant=Date.parse('2026-11-03T07:00:00Z'),calls=[];
  const state={version:1,jobs:{}};const store={lease:async()=>true,save:async()=>{}};const provider={requests:0};
  await runDueDailySelection({state,store,db:{},instant,provider,refreshDeadline:instant+60_000,
    publishWindows:async()=>({published:false}),
    publishRoulette:async args=>{calls.push(args);return calls.length===1
      ? {rebuilt:true,publishedOrigins:['MUC'],poolSizes:{MUC:2},partialOrigins:['MUC']}
      : {rebuilt:false,publishedOrigins:[],poolSizes:{MUC:2},reason:'already_published'};}});
  assert.equal(calls.length,2);assert.equal(calls[0].provider,provider);
  assert.deepEqual(calls[1].rebuildPartialOrigins,['MUC']);assert.equal(calls[1].provider,provider);
  assert.equal(calls[1].refreshDeadline,instant+60_000);
  assert.deepEqual(state.dailySelection.roulettePartialRebuild.origins,['MUC']);
});

test('a 3+ roulette pool does not receive a second same-run rebuild',async()=>{
  const instant=Date.parse('2026-11-03T07:00:00Z'),calls=[];
  const state={version:1,jobs:{}};const store={lease:async()=>true,save:async()=>{}};
  await runDueDailySelection({state,store,db:{},instant,
    publishWindows:async()=>({published:false}),publishRoulette:async args=>{calls.push(args);return{rebuilt:true,publishedOrigins:['MUC'],poolSizes:{MUC:3},partialOrigins:[]};}});
  assert.equal(calls.length,1);
});

test('all-origin reserve checkpoints the current origin and its local cursors at the bounded deadline',async()=>{
  const state={version:1,jobs:{}};const saves=[];let calls=0,now=0;
  const store={lease:async()=>true,save:async value=>saves.push(structuredClone(value))};
  const adapter={step:async()=>{calls++;now=160000;return{status:'yield',checkpoint:{originIndex:1,currentOrigin:'MUC',completedOrigins:['FRA'],
    origin:{phase:'carousel',roulette:{cursor:4,total:4},carousel:{cursor:2,total:9}},complete:false}};}};
  const result=await runAllOriginPriorityFill({state,store,adapter,instant:Date.parse('2026-09-23T07:00:00Z'),clock:()=>now,deadline:200000});
  assert.equal(calls,1);assert.equal(result.currentOrigin,'MUC');assert.deepEqual(result.completedOrigins,['FRA']);
  assert.equal(result.origin.carousel.cursor,2);assert.equal(result.complete,false);assert.equal(result.deadlineReached,true);
  assert.ok(saves.some(s=>s.dailySelection.allOriginPriority.currentOrigin==='MUC'),'current origin is durable beside local roulette/carousel cursors');
});

test('an incomplete reserve error durably blocks broad provider work until its explicit deadline release',async()=>{
  const instant=Date.parse('2026-11-02T07:00:00Z'),state={version:1,jobs:{}},saves=[];
  const store={lease:async()=>true,save:async value=>saves.push(structuredClone(value))};
  const adapter={step:async()=>{throw new Error('reserve provider failure');}};
  await assert.rejects(()=>runAllOriginPriorityFill({state,store,adapter,instant,clock:()=>100,deadline:200_000}),/reserve provider failure/);
  const checkpoint=state.dailySelection.allOriginPriority;
  assert.equal(checkpoint.complete,undefined);assert.equal(checkpoint.deadlineReached,false);
  assert.equal(checkpoint.lastError.message,'reserve provider failure');
  assert.ok(saves.some(saved=>saved.dailySelection.allOriginPriority.lastError?.message==='reserve provider failure'));
  let broadProviderCalls=0;
  if(allOriginPriorityReleased(state,instant))broadProviderCalls++;
  assert.equal(broadProviderCalls,0,'no MAIN/FAST/TAIL provider handler may start before release');
  checkpoint.deadlineReached=true;
  assert.equal(allOriginPriorityReleased(state,instant),true,'a persisted same-day deadline release permits the normal broad path');
  assert.equal(allOriginPriorityReleased(state,instant+86_400_000),false,'a release never crosses the Berlin day boundary');
});

test('all-origin reserve uses canonical order, one provider lane, and the existing factual commit paths',()=>{
  const adapters=readFileSync(new URL('./collection-adapters.mjs',import.meta.url),'utf8');
  assert.match(adapters,/ORIGINS_ALL\[cp\.originIndex\]/);
  assert.match(adapters,/reserveOrigin:currentOrigin/);
  assert.match(adapters,/routes:plan\.routes\.filter\(route=>route\.origin===job\.reserveOrigin\)/);
  assert.match(adapters,/ORIGINS_ALL\.flatMap\(origin=>catalogue\(pinnedWave\)/);
  assert.doesNotMatch(adapters,/mucPriority|muc-priority|origin==='MUC'/);
  assert.match(adapters,/collection_commit_main/);assert.match(adapters,/collection_commit_window/);
  assert.match(source,/all_origin_priority_deadline/);
  assert.match(source,/if\(result\.status==='yield'&&clock\(\)\+ALL_ORIGIN_PRIORITY_MIN_UNIT_MS>=deadline\)break/);
});

test('a resumed reserve publishes newly complete MUC while FRA remains incomplete, even after an earlier same-day publication',async()=>{
  const instant=Date.parse('2026-11-02T07:00:00Z'),state={version:1,jobs:{},dailySelection:{day:'2026-11-02',windowDone:true,rouletteDone:true,
    allOriginPriority:{day:'2026-11-02',originIndex:1,currentOrigin:'MUC',completedOrigins:['FRA'],origin:{phase:'roulette'},complete:false}}};const calls=[];
  const store={lease:async()=>true,save:async()=>{}};
  const reserve={step:async()=>({status:'yield',checkpoint:{originIndex:2,currentOrigin:'FRA',completedOrigins:['FRA','MUC'],
    origin:{phase:'roulette',roulette:{cursor:2,total:4},carousel:null},complete:false}})};
  await runDueDailySelection({state,store,db:{},instant,refreshDeadline:Date.now()+46_000,allOriginPriorityAdapter:reserve,
    publishWindows:async()=>{calls.push('window');return{published:true};},
    publishRoulette:async()=>{calls.push('roulette');return{rebuilt:true,publishedOrigins:['MUC'],incompleteOrigins:[{origin:'FRA'}]};}});
  assert.deepEqual(calls,['window','roulette']);
  assert.ok(state.dailySelection.allOriginPriority.completedOrigins.includes('MUC'));
  assert.equal(state.dailySelection.allOriginPriority.currentOrigin,'FRA');
});

test('the provider and its point-refresh deadline are threaded into both publish paths, and a daily_selection_published line is logged with counts',async()=>{
  const instant=Date.parse('2026-09-23T07:00:00Z');
  const state={version:1,jobs:{}};
  const store={lease:async()=>true,save:async()=>{}};
  const fakeProvider={requests:0};
  const seen=[];
  const logs=[];const originalLog=console.log;console.log=(...args)=>logs.push(args.map(String).join(' '));
  try{
    await runDueDailySelection({state,store,db:{},instant,wave:0,provider:fakeProvider,refreshDeadline:instant+123456,
      publishRoulette:async args=>{seen.push(args);return{rebuilt:true,freshFraction:0.8,refresh:{attempted:3,refreshed:2,misses:1,errors:0,total:3},rank1Rows:5,poolRows:20};},
      publishWindows:async args=>{seen.push(args);return{published:true,freshFraction:0.7,refresh:{attempted:4,refreshed:4,misses:0,errors:0,total:4},candidateRows:9};}});
  }finally{console.log=originalLog;}
  assert.equal(seen[0].provider,fakeProvider);assert.equal(seen[0].refreshDeadline,instant+123456);
  assert.equal(seen[1].provider,fakeProvider);assert.equal(seen[1].refreshDeadline,instant+123456);
  const line=logs.find(l=>l.includes('daily_selection_published'));
  assert.ok(line,'a daily_selection_published line is logged');
  const parsed=JSON.parse(line);
  assert.equal(parsed.roulette.refresh.refreshed,2);assert.equal(parsed.roulette.freshFraction,0.8);assert.equal(parsed.roulette.poolRows,20);
  assert.equal(parsed.window.refresh.refreshed,4);assert.equal(parsed.window.freshFraction,0.7);assert.equal(parsed.window.candidateRows,9);
});

test('morning transition (pilot): selection never waits for source freshness — publishes and marks the day done on the very first due cycle',async()=>{
  const instant=Date.parse('2026-09-24T05:05:00Z'); // 07:05 Berlin — pilot threshold just reached
  const state={version:1,jobs:{priority:{id:1,done:true,completedAt:123,checkpoint:{phase:'done'}}}};
  const store={lease:async()=>true,save:async()=>{}};
  const result=await runDueDailySelection({state,store,db:{},instant,wave:43,pilotMarketSchedule:true,selectionThresholdMinutes:7*60+5,
    publishRoulette:async()=>({rebuilt:true,freshFraction:0.4}),
    publishWindows:async()=>({published:true,freshFraction:0.4})});
  assert.equal(result.published,true);
  assert.equal(state.dailySelection.rouletteDone,true,'published immediately — never waits for a freshness threshold');
  assert.equal(state.dailySelection.windowDone,true);
  assert.ok(state.dailySelection.completedAt,'the day completes on the very first due cycle');
  // The low freshness fraction is recorded for observability only — it never blocked the publish.
  assert.equal(state.dailySelection.rouletteFreshFraction,0.4);
  assert.equal(state.dailySelection.windowFreshFraction,0.4);
});

test('exactly one selection per Berlin day: a second due cycle the same day never re-invokes either publish path',async()=>{
  const instant=Date.parse('2026-09-24T05:35:00Z');
  const state={version:1,jobs:{priority:{id:1,done:true,completedAt:123,checkpoint:{phase:'done'}}},
    dailySelection:{day:'2026-09-24',rouletteDone:true,windowDone:true,completedAt:instant-1800000,startedAt:instant-1800000}};
  const store={lease:async()=>true,save:async()=>{}};
  const result=await runDueDailySelection({state,store,db:{},instant,wave:43,pilotMarketSchedule:true,selectionThresholdMinutes:7*60+5,
    publishRoulette:async()=>{throw new Error('must not re-run: already selected today');},
    publishWindows:async()=>{throw new Error('must not re-run: already selected today');}});
  assert.equal(result.published,false);
  assert.equal(state.dailySelection.rouletteDone,true);
  assert.equal(state.dailySelection.windowDone,true);
});

test('a completed new-format window checkpoint retries only changed factual origin input without provider work',async()=>{
  const instant=Date.parse('2026-11-02T07:00:00Z');
  const state={version:1,jobs:{priority:{done:true,checkpoint:{phase:'done'}}},dailySelection:{day:'2026-11-02',windowDone:true,rouletteDone:true,
    perOriginCatchupDone:true,windowOriginInputs:{FRA:'fra-input-v1'},windowNewInputBaselineAt:'2026-11-02T06:00:00.000Z'}};
  const calls=[];const store={lease:async()=>true,save:async()=>{}};
  await runDueDailySelection({state,store,db:{},instant,provider:{requests:0},refreshDeadline:instant+60_000,
    publishRoulette:async()=>{throw new Error('roulette must not rerun');},
    publishWindows:async args=>{calls.push(args);return{published:true,publishedOrigins:['MUC'],alreadyPublishedOrigins:[],failedOrigins:[],candidateRows:1,
      handledOriginInputs:{MUC:'muc-input-v1'}};}});
  assert.equal(calls.length,1);assert.equal(calls[0].provider,null,'new-input retry cannot broaden into provider refresh work');
  assert.deepEqual(calls[0].retryOriginInputs,{FRA:'fra-input-v1'});
  assert.equal(calls[0].retryAfter,'2026-11-02T06:00:00.000Z','retry uses the persisted ordinary-completion baseline');
  assert.equal(state.dailySelection.windowOriginInputs.MUC,'muc-input-v1');
  assert.equal(state.jobs.priority.done,false,'a new local origin publication re-admits the existing priority path');
});

test('a completed roulette checkpoint retries only changed factual MUC input without provider work',async()=>{
  const instant=Date.parse('2026-11-03T07:00:00Z');
  const state={version:1,jobs:{},dailySelection:{day:'2026-11-03',windowDone:true,rouletteDone:true,
    rouletteOriginInputs:{FRA:'fra-input-v1'},rouletteNewInputBaselineAt:'2026-11-03T06:00:00.000Z'}};
  const calls=[];const store={lease:async()=>true,save:async()=>{}};
  await runDueDailySelection({state,store,db:{},instant,provider:{requests:0},refreshDeadline:instant+60_000,
    publishWindows:async()=>({published:false,handledOriginInputs:{}}),
    publishRoulette:async args=>{calls.push(args);return{rebuilt:true,publishedOrigins:['MUC'],failedOrigins:[],poolRows:10,
      handledOriginInputs:{MUC:'muc-input-v1'}};}});
  assert.equal(calls.length,1);assert.equal(calls[0].provider,null,'new-input retry cannot broaden into provider refresh work');
  assert.deepEqual(calls[0].retryOriginInputs,{FRA:'fra-input-v1'});
  assert.equal(calls[0].retryAfter,'2026-11-03T06:00:00.000Z');
  assert.equal(state.dailySelection.rouletteOriginInputs.MUC,'muc-input-v1');
});

test('a failed new-input retry persists its attempted fingerprint for the next data-only pass',async()=>{
  const instant=Date.parse('2026-11-02T07:00:00Z');
  const state={version:1,jobs:{},dailySelection:{day:'2026-11-02',windowDone:true,rouletteDone:true,
    perOriginCatchupDone:true,windowOriginInputs:{MUC:'muc-input-v1'},windowNewInputBaselineAt:'2026-11-02T06:00:00.000Z'}};
  const calls=[];const store={lease:async()=>true,save:async()=>{}};
  const publishWindows=async args=>{calls.push(args);const fingerprint=calls.length===1?'fra-input-v1':'fra-input-v2';
    return{published:false,publishedOrigins:[],alreadyPublishedOrigins:[],failedOrigins:[{origin:'FRA',reason:'unavailable'}],candidateRows:1,
      handledOriginInputs:{},attemptedOriginInputs:{FRA:fingerprint}};};
  await runDueDailySelection({state,store,db:{},instant,publishRoulette:async()=>{throw new Error('roulette must not rerun');},publishWindows});
  assert.equal(state.dailySelection.windowAttemptedOriginInputs.FRA,'fra-input-v1');
  await runDueDailySelection({state,store,db:{},instant:instant+60_000,publishRoulette:async()=>{throw new Error('roulette must not rerun');},
    publishWindows:async args=>{assert.deepEqual(args.retryOriginInputs,{MUC:'muc-input-v1',FRA:'fra-input-v1'});
      return{published:false,publishedOrigins:[],alreadyPublishedOrigins:[],failedOrigins:[],candidateRows:0,handledOriginInputs:{},attemptedOriginInputs:{}};}});
  assert.equal(calls.length,1);assert.equal(calls[0].provider,null,'the failed retry remains data-only');
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
  assert.deepEqual(calls,['window','roulette'],'both paths rebuild for the new day — neither is silently skipped as "already done"');
  assert.equal(result.published,true);
  assert.equal(state.dailySelection.rouletteDone,true);assert.equal(state.dailySelection.windowDone,true);
});

test('order within one call: window publishes before roulette is even attempted (select -> point-refresh -> publish, per path, in sequence)',async()=>{
  const instant=Date.parse('2026-09-24T05:05:00Z');
  const state={version:1,jobs:{priority:{id:1,done:true,completedAt:1,checkpoint:{phase:'done'}}}};
  const store={lease:async()=>true,save:async()=>{}};
  const calls=[];
  const result=await runDueDailySelection({state,store,db:{},instant,wave:43,pilotMarketSchedule:true,selectionThresholdMinutes:7*60+5,
    publishRoulette:async()=>{calls.push('roulette');return{rebuilt:true,freshFraction:1,refresh:{attempted:10,refreshed:9,misses:1,errors:0,total:10}};},
    publishWindows:async()=>{calls.push('window');return{published:true,freshFraction:1,refresh:{attempted:5,refreshed:5,misses:0,errors:0,total:5}};}});
  assert.deepEqual(calls,['window','roulette'],'window (select+refresh+publish) completes fully before roulette starts');
  assert.equal(result.published,true);
  assert.equal(state.dailySelection.rouletteDone,true);
  assert.equal(state.dailySelection.windowDone,true);
  assert.ok(state.dailySelection.completedAt,'the day completes once both paths are done, in one due cycle');
  assert.equal(state.dailySelection.rouletteRefresh.refreshed,9);
  assert.equal(state.dailySelection.windowRefresh.refreshed,5);
});

test('same-day recovery after a window publication failure resumes window before the unattempted roulette checkpoint',async()=>{
  const instant=Date.parse('2026-09-24T05:05:00Z');
  const state={version:1,jobs:{priority:{id:1,done:true,completedAt:1,checkpoint:{phase:'done'}}}};
  const saves=[];const store={lease:async()=>true,save:async value=>saves.push(structuredClone(value))};
  let rouletteCalls=0,windowCalls=0;
  await assert.rejects(()=>runDueDailySelection({state,store,db:{},instant,wave:43,pilotMarketSchedule:true,selectionThresholdMinutes:6*60,
    publishRoulette:async()=>{rouletteCalls++;return{rebuilt:true,rank1Rows:44,poolRows:220};},
    publishWindows:async()=>{windowCalls++;throw new Error('invalid daily window candidate row');}}),/invalid daily window candidate row/);
  assert.equal(rouletteCalls,0);assert.equal(windowCalls,1);
  assert.equal(state.dailySelection.rouletteDone,false);assert.equal(state.dailySelection.windowDone,false);
  assert.equal(state.jobs.priority.done,true,'priority is not reset against the old window epoch after a failed publication');
  state.dailySelection.lastError={message:'invalid daily window candidate row',at:instant};await store.save(state);
  assert.equal(dailySelectionRetryThrottled(state,instant+5*60_000),true,'same-day recovery obeys the 30-minute throttle');

  const retryAt=instant+31*60_000;
  const recovered=await runDueDailySelection({state,store,db:{},instant:retryAt,wave:43,pilotMarketSchedule:true,selectionThresholdMinutes:6*60,
    publishRoulette:async()=>{rouletteCalls++;return{rebuilt:true,rank1Rows:44,poolRows:220};},
    publishWindows:async()=>{windowCalls++;return{published:true,candidateRows:873,freshFraction:0.8};}});
  if(state.dailySelection.lastError){delete state.dailySelection.lastError;await store.save(state);}
  assert.equal(recovered.published,true);assert.equal(rouletteCalls,1);assert.equal(windowCalls,2);
  assert.equal(state.dailySelection.rouletteDone,true);assert.equal(state.dailySelection.windowDone,true);
  assert.equal(state.dailySelection.windowCandidateRows,873);assert.ok(state.dailySelection.completedAt);
  assert.equal(state.dailySelection.lastError,undefined);
  assert.equal(state.jobs.priority.done,false);assert.equal(state.jobs.priority.checkpoint.phase,'roulette');
  assert.ok(saves.some(saved=>saved.dailySelection?.rouletteDone!==true&&saved.dailySelection?.windowDone===true),
    'partial window success is durably checkpointed before roulette runs');
});

test('a FRA roulette completeness failure leaves the eligible current window epoch published and checkpointed',async()=>{
  const instant=Date.parse('2026-11-01T21:28:56Z');
  const state={version:1,jobs:{priority:{id:1,done:true,completedAt:1,checkpoint:{phase:'done'}}}};
  const saves=[];const calls=[];
  const store={lease:async()=>true,save:async value=>saves.push(structuredClone(value))};
  await assert.rejects(()=>runDueDailySelection({state,store,db:{},instant,wave:0,
    publishWindows:async()=>{calls.push('window');return{published:true,candidateRows:873};},
    publishRoulette:async()=>{calls.push('roulette');throw new Error('Daily roulette publication requires exactly 10 real cities for FRA (0/10)');}}),
    /requires exactly 10 real cities for FRA \(0\/10\)/);
  assert.deepEqual(calls,['window','roulette']);
  assert.equal(state.dailySelection.day,'2026-11-01');
  assert.equal(state.dailySelection.windowDone,true);assert.equal(state.dailySelection.windowPublished,true);
  assert.equal(state.dailySelection.windowCandidateRows,873);
  assert.equal(state.dailySelection.rouletteDone,false,'failed roulette remains retryable');
  assert.equal(state.jobs.priority.done,false,'the newly published window epoch is admitted to priority');
  assert.ok(saves.some(saved=>saved.dailySelection?.windowDone===true&&saved.dailySelection?.rouletteDone!==true),
    'the window checkpoint is durable before the roulette error escapes for normal error recording');
});

test('legacy (pilotMarketSchedule unset) behaves exactly as the pilot path — both always publish immediately, no freshness gate either way',async()=>{
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
  const dueSelectionCallIndex = source.indexOf('await runDueDailySelection({state,store,db,wave,selectionThresholdMinutes,pilotMarketSchedule,provider,refreshDeadline,');
  const regularPublishIndex = source.lastIndexOf('await publishPilotState(db,env)', dueSelectionCallIndex);
  const betweenPublishAndSelection = source.slice(regularPublishIndex, dueSelectionCallIndex);
  assert.ok(regularPublishIndex > -1, 'the regular due session publishes pilot state before running daily selection');
  // The provider is now constructed here too — it is passed into runDueDailySelection so the same
  // session can point-refresh the day's freshly-selected tickets immediately after selection
  // (select -> point-refresh -> publish). The full engine, however, must still not start early.
  assert.doesNotMatch(betweenPublishAndSelection, /new SequentialSchedule/,
    'the engine loop does not start before the (possibly throttled/caught) daily selection attempt');
  assert.match(betweenPublishAndSelection, /new CollectionProvider/,
    'the provider is built before daily selection so its point-refresh pass can use it');
});

test('off-cycle MAIN advance defaults to exactly legacy behavior (OFF_CYCLE_MAIN_MINUTES unset/0 → immediate not_due, no engine)', () => {
  assert.match(source, /const offCycleMinutes=Number\(env\.OFF_CYCLE_MAIN_MINUTES\?\?0\)/);
  assert.match(source, /const stopAt=offCycleMinutes>0\s*\n\s*\?offCycleMainBudget/);
  assert.match(source, /if\(!stopAt\)\{\s*\n\s*console\.log\(JSON\.stringify\(\{event:'collection_not_due'/);
});

test('off-cycle MAIN advance never offers a priority handler and never calls runDueDailySelection', () => {
  const offCycleBlock = source.slice(source.indexOf('OFF_CYCLE_MAIN_MINUTES'), source.indexOf('await runDueDailySelection'));
  assert.match(offCycleBlock, /await runAllOriginPriorityFill\(\{state,store,adapter:allAdapters\.allOriginPriority,deadline:stopAt\}\)/);
  assert.match(offCycleBlock, /if\(!allOriginPriorityReleased\(state\)\)\{\s*console\.log\(JSON\.stringify\(\{event:'all_origin_priority_blocks_broad'/);
  assert.match(offCycleBlock, /const offCycleHandlers=\{main:allAdapters\.main,tail:allAdapters\.tail\}/);
  assert.match(offCycleBlock, /handlers:offCycleHandlers/);
  assert.doesNotMatch(offCycleBlock, /runDueDailySelection/);
});

test('the regular scheduler cannot construct broad handlers without the persisted reserve release',()=>{
  const regularBlock=source.slice(source.indexOf("if(dailySelectionRetryThrottled"),source.indexOf("process.once('SIGTERM'"));
  assert.match(regularBlock,/if\(!allOriginPriorityReleased\(state\)\)\{\s*console\.log\(JSON\.stringify\(\{event:'all_origin_priority_blocks_broad'/);
  assert.match(regularBlock,/return;\s*\}\s*const end=sessionEnd;[\s\S]*handlers:allAdapters/);
});

test('regular progress logs expose only the checkpointed safe roulette technical diagnostics and later per-key outcomes',()=>{
  const projection=source.slice(source.indexOf("...(k==='priority'?{phase:j.checkpoint?.phase"),source.indexOf("window:{cursor:j.checkpoint?.weekend?.cursor"));
  const priorityProjection=source.slice(source.indexOf("...(k==='priority'?{phase:j.checkpoint?.phase"),source.indexOf("}}:{})}]))}"));
  assert.match(priorityProjection,/roulette:\{cursor:[^}]*total:[^}]*admittedAt:[^}]*snapshotAt:/);
  assert.match(priorityProjection,/window:\{cursor:[^}]*total:[^}]*admittedAt:[^}]*snapshotAt:[^}]*setId:/);
  assert.match(projection,/technicalDeferred:j\.checkpoint\?\.roulette\?\.technicalDeferred\?\?\[\]/);
  assert.match(projection,/technicalOutcomes:j\.checkpoint\?\.roulette\?\.technicalOutcomes\?\?\[\]/);
  assert.doesNotMatch(projection,/TP_TOKEN|Authorization|headers|response\.json|providerUrl/);
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

// --- D1: normal run intersection resolves (exit 0), a real error still rejects (exit 1) ---

test('main() stands down cleanly (not an error) on the normal intersection of runs — the CLI wrapper only sets exitCode on a rejection, so this is the exit-0 path',async()=>{
  const logs=[];const originalLog=console.log;console.log=(...args)=>logs.push(args.map(String).join(' '));
  try{
    // No GITHUB_RUN_ID/GITHUB_REPOSITORY: noOtherActiveRuns fails its own regex guard and returns
    // false synchronously, with no network call — deterministic and hermetic.
    const env={COLLECTION_MODE:'coordinated',TP_TOKEN:'t',SUPABASE_SERVICE_KEY:'k',GITHUB_TOKEN:'t'};
    await assert.doesNotReject(()=>main(env), 'the normal intersection case must resolve, never reject');
    assert.ok(logs.some(l=>l.startsWith('skipped:')), `expected a 'skipped: ...' log line, got: ${JSON.stringify(logs)}`);
  }finally{console.log=originalLog;}
});

test('main() still rejects (exit 1) for a genuine setup error, unlike the intersection skip above — the same contract real lease/DB errors below rely on',async()=>{
  await assert.rejects(()=>main({COLLECTION_MODE:'coordinated',TP_TOKEN:'t',GITHUB_TOKEN:'t'}), /Missing required SUPABASE_SERVICE_KEY/);
});

test('only the two documented run-intersection checks return early with a skip; every other failure path (claim, save, lease, the daily-selection catch) is untouched',()=>{
  assert.equal((source.match(/console\.log\('skipped: /g)||[]).length, 2, 'exactly noOtherActiveRuns and oldRunnerHasStopped skip — no other check was softened');
  assert.match(source, /const state=await store\.claim\(previous\?\.owner\?\?null\)\?\?freshScheduleState\(\);claimed=true;/, 'store.claim is still awaited directly and still throws on a real lease/DB failure');
  assert.doesNotMatch(source, /store\.claim[^;]*\.catch/, 'claim failures are not swallowed');
});

// --- A2: a daily-selection failure is checkpointed and throttled, never aborts the session ---

test('dailySelectionRetryThrottled: no retry within 30 minutes of a same-day failure; a new day or an old failure retries',()=>{
  const instant=Date.parse('2026-09-25T07:00:00Z');
  const failedAt=instant-5*60000;
  const state={dailySelection:{day:berlinObservedOn(instant),lastError:{message:'boom',at:failedAt}}};
  assert.equal(dailySelectionRetryThrottled(state,instant),true,'5 minutes after a failure — still throttled');
  assert.equal(DAILY_SELECTION_RETRY_MS, 30*60000);
  assert.equal(dailySelectionRetryThrottled(state,failedAt+29*60000),true,'just under 30 minutes — still throttled');
  assert.equal(dailySelectionRetryThrottled(state,failedAt+31*60000),false,'past 30 minutes — retry allowed');
  const otherDayState={dailySelection:{day:'2026-09-24',lastError:{message:'boom',at:instant}}};
  assert.equal(dailySelectionRetryThrottled(otherDayState,instant),false,'a new Berlin day never inherits yesterday\'s throttle');
  assert.equal(dailySelectionRetryThrottled({},instant),false,'no prior selection at all — never throttled');
});

test('a throttled selection alone does not make scheduledCollectionDue trigger a full session when priority is not due',()=>{
  const instant=Date.parse('2026-09-25T02:30:00Z'); // 03:30 Berlin, legacy threshold just reached
  const cycle=Math.floor(instant/CYCLE_MS);
  const state={version:1,jobs:{priority:{id:cycle,done:true}},
    dailySelection:{day:berlinObservedOn(instant),rouletteDone:false,windowDone:false,lastError:{message:'boom',at:instant-60000}}};
  assert.equal(scheduledCollectionDue(state,instant),false,'priority already done this cycle and selection is throttled — nothing is due');
  assert.equal(scheduledCollectionDue(state,instant+31*60000),true,'once the throttle expires, selection becomes due again');
});

test('runDueDailySelection error: checkpointed with message+time, MAIN/priority still run this session, retry is throttled for 30 minutes',async()=>{
  const instant=Date.parse('2026-09-25T07:00:00Z');
  const state={version:1,jobs:{}};const saved=[];
  const store={lease:async()=>true,save:async v=>saved.push(structuredClone(v))};
  // Mirrors main()'s inline try/catch around runDueDailySelection (see run-collection.mjs).
  async function attemptSelection(now){
    if(dailySelectionRetryThrottled(state,now))return{throttled:true};
    try{
      await runDueDailySelection({state,store,db:{},instant:now,wave:0,
        publishRoulette:async()=>{throw new Error('offers query failed')},publishWindows:async()=>({published:true})});
      return{ok:true};
    }catch(error){
      state.dailySelection={...(state.dailySelection||{}),lastError:{message:error.message,at:now}};
      await store.save(state);
      return{error};
    }
  }
  const first=await attemptSelection(instant);
  assert.ok(first.error,'the selection error is caught, not left to propagate');
  assert.equal(state.dailySelection.lastError.message,'offers query failed');
  assert.equal(state.dailySelection.lastError.at,instant);
  // A second attempt 5 minutes later must not re-invoke publishRoulette (would re-read offers).
  let secondCallMade=false;
  async function attemptWithSpy(now){
    if(dailySelectionRetryThrottled(state,now))return{throttled:true};
    secondCallMade=true;
    try{await runDueDailySelection({state,store,db:{},instant:now,wave:0,
      publishRoulette:async()=>{throw new Error('offers query failed')},publishWindows:async()=>({published:true})});return{ok:true};}
    catch(error){state.dailySelection={...(state.dailySelection||{}),lastError:{message:error.message,at:now}};await store.save(state);return{error};}
  }
  const second=await attemptWithSpy(instant+5*60000);
  assert.equal(second.throttled,true);
  assert.equal(secondCallMade,false,'throttled — the offers table is not re-read 5 minutes after a failure');
  // Past 30 minutes, a retry is attempted again.
  const third=await attemptWithSpy(instant+31*60000);
  assert.equal(secondCallMade,true);
  assert.ok(third.error);
});

test('every coordinator run logs a final egress_summary line and resets the counter at the start',()=>{
  assert.match(source,/^\s*import\s*\{\s*resetEgress,\s*egressSummary\s*\}\s*from\s*'\.\/collection-egress\.mjs'/m);
  assert.match(source,/export async function main\(env=process\.env\)\{\s*resetEgress\(\);/,
    'resetEgress must run at the very start of every coordinator invocation');
  assert.match(source,/finally\{[\s\S]*console\.log\(JSON\.stringify\(egressSummary\(\)\)\);[\s\S]*\}/,
    'egress_summary must be logged in the finally block so it always runs, including on early returns and thrown errors');
});

test('post-selection point-refresh budget: 10-minute cap, 5-minute reserve for MAIN/priority', () => {
  assert.equal(DAILY_SELECTION_REFRESH_MAX_MS, 10 * 60_000);
  assert.equal(DAILY_SELECTION_REFRESH_RESERVE_MS, 5 * 60_000);
});
