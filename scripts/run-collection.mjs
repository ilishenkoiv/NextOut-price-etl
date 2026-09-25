import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { CollectionStore, oldRunnerHasStopped } from './collection-store.mjs';
import { CollectionProvider } from './collection-provider.mjs';
import { SequentialSchedule, freshScheduleState, CYCLE_MS, offCycleMainBudget, runBoundedMainAdvance } from './collection-schedule.mjs';
import { createAdapters } from './collection-adapters.mjs';
import { resetEgress, egressSummary } from './collection-egress.mjs';
import { publishPilotState } from './pilot-price-metadata.mjs';
import { expansionTargets } from '../src/data/expansion-targets.js';
import { main as publishDailyRoulette, berlinObservedOn, nightlySelectionDue, LEGACY_SELECTION_THRESHOLD_MINUTES, PILOT_SELECTION_THRESHOLD_MINUTES } from './snapshot-daily-origin-cheapest.mjs';
import { main as publishDailyWindows } from './snapshot-daily-window-candidates.mjs';

// Headroom an off-cycle (priority-not-due) trigger must always leave before the next real due
// (priority) cycle. Generous relative to observed GH Actions/DB overhead (a due session's own
// checkout+npm-ci+claim overhead measured ~15-20s) so a slow runner start never eats into it.
export const OFF_CYCLE_SAFETY_MARGIN_MS = 90_000;

// A daily-selection failure (bad source data, a transient DB error, etc.) is recorded on the
// checkpoint with its message and timestamp instead of aborting the whole session. This throttle
// keeps a persistently failing selection from re-reading the full offers table on every
// invocation of this coordinator (as often as every 5 minutes via supabase-cron): a retry is
// attempted at most once per this interval; MAIN and priority still run every time regardless.
export const DAILY_SELECTION_RETRY_MS = 30 * 60_000;

export async function noOtherActiveRuns(env, fetchImpl = fetch) {
  if (!env.GITHUB_TOKEN || !/^\d+$/.test(env.GITHUB_RUN_ID ?? '') || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY ?? '')) return false;
  for(let page=1;page<=10;page++){
    try{
      const response=await fetchImpl(`https://api.github.com/repos/${env.GITHUB_REPOSITORY}/actions/runs?status=in_progress&per_page=100&page=${page}`,{
        headers:{Authorization:`Bearer ${env.GITHUB_TOKEN}`,Accept:'application/vnd.github+json'},signal:AbortSignal.timeout(8000)});
      if(!response.ok)return false;
      const body=await response.json();if(!Array.isArray(body.workflow_runs))return false;
      if(body.workflow_runs.some(r=>String(r.id)!==env.GITHUB_RUN_ID))return false;
      if(body.workflow_runs.length<100)return true;
    }catch{return false;}
  }
  return false;
}

export function scheduledCollectionDue(state, instant=Date.now(), selectionThresholdMinutes=LEGACY_SELECTION_THRESHOLD_MINUTES) {
  if(!state||state.version!==1||!state.jobs)return true;
  const cycle=Math.floor(instant/CYCLE_MS),priority=state.jobs.priority;
  const priorityDue=!priority||priority.id!==cycle||!priority.done;
  const day=berlinObservedOn(instant),selection=state.dailySelection;
  const selectionIncomplete=selection?.day!==day||selection.rouletteDone!==true||selection.windowDone!==true;
  // A recent same-day selection failure is not due again yet — see dailySelectionRetryThrottled.
  const selectionDue=nightlySelectionDue(instant,selectionThresholdMinutes)&&selectionIncomplete
    &&!dailySelectionRetryThrottled(state,instant);
  return priorityDue||selectionDue;
}

export function collectionTriggerSource(env={}){
  const source=String(env.COLLECTION_TRIGGER_SOURCE||env.GITHUB_EVENT_NAME||'manual');
  if(!/^[a-z0-9-]{1,32}$/.test(source))throw new Error('Invalid collection trigger source');
  return source;
}

export function isAutomatedTrigger(env={}){
  const source=collectionTriggerSource(env);
  return env.GITHUB_EVENT_NAME==='schedule'||source==='supabase-cron';
}

// Daily membership publication is now a checkpointed coordinator phase. It runs after the
// single database claim, verifies the lease before each idempotent once/day publication and
// fences each phase transition through CollectionStore.save. Manual selector workflows remain
// recovery-only; no independently scheduled selection writer exists.
export async function runDueDailySelection({state,store,db,wave=0,instant=Date.now(),selectionThresholdMinutes=LEGACY_SELECTION_THRESHOLD_MINUTES,
  pilotMarketSchedule=false,publishRoulette=publishDailyRoulette,publishWindows=publishDailyWindows}={}) {
  if(!nightlySelectionDue(instant,selectionThresholdMinutes))return{state,published:false};
  const day=berlinObservedOn(instant),snapshotAt=new Date(instant).toISOString();
  const checkpoint=state.dailySelection?.day===day?structuredClone(state.dailySelection):{
    day,rouletteDone:false,windowDone:false,startedAt:instant};
  state.dailySelection=checkpoint;await store.save(state);
  let published=false;
  if(!checkpoint.rouletteDone){
    if(!await store.lease())throw new Error('Daily roulette selection forbidden: lease lost');
    const result=await publishRoulette({db,snapshotAt,expansionWave:wave,pilotMarketSchedule});
    // sources_not_fresh (pilot only): sources have not shown a fresh post-pause pass yet — this
    // is NOT "done for the day". Leave rouletteDone false so the next due cycle retries; never
    // publish (or mark complete) a pool built from stale pre-pause prices.
    if(result?.reason!=='sources_not_fresh'){
      checkpoint.rouletteDone=true;checkpoint.roulettePublished=result?.rebuilt===true;checkpoint.rouletteCompletedAt=Date.now();
    } else checkpoint.rouletteSourcesNotFreshAt=Date.now();
    await store.save(state);published ||= checkpoint.roulettePublished===true;
  }
  if(!checkpoint.windowDone){
    if(!await store.lease())throw new Error('Daily window selection forbidden: lease lost');
    const result=await publishWindows({db,instant,wave,pilotMarketSchedule});
    if(result?.reason!=='sources_not_fresh'){
      checkpoint.windowDone=true;checkpoint.windowPublished=result?.published===true;checkpoint.windowCompletedAt=Date.now();
    } else checkpoint.windowSourcesNotFreshAt=Date.now();
    await store.save(state);published ||= checkpoint.windowPublished===true;
    if(checkpoint.windowPublished&&state.jobs.priority){
      state.jobs.priority.done=false;state.jobs.priority.completedAt=null;
      if(state.jobs.priority.checkpoint)state.jobs.priority.checkpoint.phase='roulette';
      await store.save(state);
    }
  }
  if(checkpoint.rouletteDone&&checkpoint.windowDone)checkpoint.completedAt=Date.now();
  await store.save(state);
  return{state,published};
}

// Whether a same-day daily-selection failure is recent enough (within retryMs) to skip retrying
// it this cycle. Shared by scheduledCollectionDue (so a throttled selection alone never makes an
// otherwise-idle off-cycle trigger think a full due session is needed) and by main() itself.
export function dailySelectionRetryThrottled(state, instant, retryMs=DAILY_SELECTION_RETRY_MS) {
  const selection=state?.dailySelection;
  if(selection?.day!==berlinObservedOn(instant))return false;
  const lastError=selection.lastError;
  return Boolean(lastError?.at)&&(instant-lastError.at)<retryMs;
}

export async function main(env=process.env){
  resetEgress();
  if(env.COLLECTION_MODE!=='coordinated')throw new Error('Coordinated mode has not been enabled');
  for(const key of ['TP_TOKEN','SUPABASE_SERVICE_KEY','GITHUB_TOKEN'])if(!env[key])throw new Error(`Missing required ${key}`);
  const triggerSource=collectionTriggerSource(env),automated=isAutomatedTrigger(env);
  console.log(JSON.stringify({event:'collection_trigger',source:triggerSource,githubEvent:env.GITHUB_EVENT_NAME||null}));
  const wave=Number(env.EXPANSION_WAVE??0);expansionTargets(wave);
  const minutes=Number(env.COLLECTION_SESSION_MINUTES??25);
  if(!Number.isInteger(minutes)||minutes<1||minutes>240)throw new Error('Session must be 1–240 minutes');
  // Normal intersection of runs (another workflow already in progress, or GitHub state is
  // unreadable): not an error, just this run standing down. Exit 0, not 1 — a real lease/DB
  // failure below still throws and exits 1.
  if(!await noOtherActiveRuns(env)){console.log('skipped: other active workflow run or unknown GitHub state; no collection started');return;}
  let dbDeadline=Infinity; let activeStore=null;
  const db=createClient(env.SUPABASE_URL||'https://xpalogebawoljlafsafs.supabase.co',env.SUPABASE_SERVICE_KEY,{
    auth:{persistSession:false,autoRefreshToken:false},global:{fetch:async(input,init={})=>{
      if(Date.now()+9000>=dbDeadline)throw new Error('Snapshot database time budget exhausted');
      const url=typeof input==='string'?input:input.url??String(input);
      if(activeStore&&!url.includes('/rpc/collection_state_')&&!await activeStore.lease())throw new Error('Database lease lost');
      return fetch(input,{...init,signal:init.signal?AbortSignal.any([init.signal,AbortSignal.timeout(8000)]):AbortSignal.timeout(8000)});
    }},
  });
  const store=new CollectionStore(db,randomUUID(),env.GITHUB_RUN_ID);
  activeStore=store;
  let claimed=false,engine=null,stopping=false;const stop=()=>{stopping=true;};
  try{
    const previous=await store.inspect();
    // Same normal-intersection case as above (an old runner from the previous cycle has not yet
    // confirmed it stopped): stand down cleanly, exit 0. A real lease/DB failure below still throws.
    if(!await oldRunnerHasStopped(previous,{repository:env.GITHUB_REPOSITORY,token:env.GITHUB_TOKEN})){console.log('skipped: old runner not confirmed stopped; refusing overlap');return;}
    const state=await store.claim(previous?.owner??null)??freshScheduleState();claimed=true;
    if(state.version!==1||!state.jobs||typeof state.jobs!=='object')throw new Error('Unsupported stored checkpoint');
    const pilotMarketSchedule=env.PRIORITY_MARKET_SCHEDULE==='pilot';
    const selectionThresholdMinutes=pilotMarketSchedule?PILOT_SELECTION_THRESHOLD_MINUTES:LEGACY_SELECTION_THRESHOLD_MINUTES;
    if(automated&&!scheduledCollectionDue(state,Date.now(),selectionThresholdMinutes)){
      // OFF_CYCLE_MAIN_MINUTES is unset/0 by default: exact legacy behavior (immediate not_due,
      // no provider work, no engine). Opt-in only. Priority is NOT due here by construction
      // (scheduledCollectionDue already covers priorityDue||selectionDue) — this path never
      // touches priority or daily selection, and never runs when it can't finish with a safety
      // margin before the next real due (priority) cycle.
      const offCycleMinutes=Number(env.OFF_CYCLE_MAIN_MINUTES??0);
      const stopAt=offCycleMinutes>0
        ?offCycleMainBudget(Date.now(),{safetyMarginMs:OFF_CYCLE_SAFETY_MARGIN_MS,maxSessionMs:offCycleMinutes*60000})
        :null;
      if(!stopAt){
        console.log(JSON.stringify({event:'collection_not_due',source:triggerSource,cycle:Math.floor(Date.now()/CYCLE_MS)}));return;
      }
      // Published once per actual off-cycle attempt (not on the immediate not_due exit above) —
      // this value only changes when the Variable is toggled, so it never needs the 5-minute
      // heartbeat's own write load; the regular due session below covers the rest of the day.
      await publishPilotState(db,env);
      const provider=new CollectionProvider({token:env.TP_TOKEN,lease:()=>store.lease()});
      const guaranteeDailyMain=env.GUARANTEE_DAILY_MAIN!=='false';
      const allAdapters=createAdapters({db,store,provider,wave,setDbDeadline:value=>{dbDeadline=value;},getState:()=>engine?.state});
      // Off-cycle exists to advance MAIN (never priority). Offering fast/maintenance here as well
      // would let a trigger that happens to land on the wall-clock 'fast' or 'maintenance' slot
      // (SLOTS is wall-clock-driven, not off-cycle-aware) spend its whole bounded budget on that
      // slot instead of MAIN, defeating the trigger's purpose. Fast/maintenance already get their
      // guaranteed due-session slot every cycle regardless of this. Tail stays as a fallback (via
      // guaranteeDailyMain/mainAtRisk) so a trigger never idles outright once MAIN is caught up.
      const offCycleHandlers={main:allAdapters.main,tail:allAdapters.tail};
      engine=new SequentialSchedule({state,lease:()=>store.lease(),save:s=>store.save(s),stopAt,guaranteeDailyMain,handlers:offCycleHandlers});
      console.log(JSON.stringify({event:'off_cycle_main_advance_start',source:triggerSource,cycle:Math.floor(Date.now()/CYCLE_MS),
        budgetMs:stopAt-Date.now(),mainCursor:engine.state.jobs.main?.checkpoint?.cursor,mainTotal:engine.state.jobs.main?.checkpoint?.total}));
      const { ticks, lastStatus } = await runBoundedMainAdvance({ engine, stopAt });
      console.log(JSON.stringify({event:'off_cycle_main_advance_end',source:triggerSource,providerRequests:provider.requests,
        ticks,lastStatus,
        progress:Object.fromEntries(Object.entries(engine.state.jobs).filter(([k])=>k!=='priority')
          .map(([k,j])=>[k,{done:j.done,cursor:j.checkpoint?.cursor,total:j.checkpoint?.total,errors:j.checkpoint?.errors}]))}));
      return;
    }
    // Published once per regular due session — every ~30 minutes at worst, well inside the
    // 120-minute ceiling this same contract publishes, so the app never reads a stale pilot flag.
    await publishPilotState(db,env);
    // A daily-selection error must never take down the whole session: priority and MAIN below
    // still need to run regardless of this call's outcome. The failure is checkpointed with its
    // message and timestamp, and dailySelectionRetryThrottled keeps a persistently failing
    // selection from re-reading the full offers table on every invocation of this coordinator.
    if(dailySelectionRetryThrottled(state,Date.now())){
      console.log(JSON.stringify({event:'daily_selection_retry_throttled',source:triggerSource,lastError:state.dailySelection.lastError}));
    }else{
      try{
        await runDueDailySelection({state,store,db,wave,selectionThresholdMinutes,pilotMarketSchedule});
        if(state.dailySelection?.lastError){delete state.dailySelection.lastError;await store.save(state);}
      }catch(error){
        state.dailySelection={...(state.dailySelection||{}),lastError:{message:error.message,at:Date.now()}};
        await store.save(state);
        console.error(JSON.stringify({event:'daily_selection_failed',source:triggerSource,error:error.message}));
      }
    }
    const end=Date.now()+minutes*60000;
    const provider=new CollectionProvider({token:env.TP_TOKEN,lease:()=>store.lease()});
    const guaranteeDailyMain=env.GUARANTEE_DAILY_MAIN!=='false';
    engine=new SequentialSchedule({state,lease:()=>store.lease(),save:s=>store.save(s),stopAt:end,guaranteeDailyMain,
      handlers:createAdapters({db,store,provider,wave,setDbDeadline:value=>{dbDeadline=value;},getState:()=>engine?.state})});
    process.once('SIGTERM',stop);process.once('SIGINT',stop);
    let lastReport=0;
    while(!stopping&&Date.now()+45000<end){
      const result=await engine.tick();
      if(Date.now()-lastReport>60000||result.status==='done'){
        console.log(JSON.stringify({task:result.task,status:result.status,cycle:result.cycle,providerRequests:provider.requests,
          completedMain:engine.state.completedMain,missedFast:engine.state.missedFast,missedPriority:engine.state.missedPriority,
          priorityLagMs:engine.state.jobs.priority?.checkpoint?.lagMs,
          progress:Object.fromEntries(Object.entries(engine.state.jobs).map(([k,j])=>[k,{done:j.done,cursor:j.checkpoint?.cursor,total:j.checkpoint?.total,
            errors:j.checkpoint?.errors,...(k==='priority'?{phase:j.checkpoint?.phase,
              roulette:{cursor:j.checkpoint?.roulette?.cursor,total:j.checkpoint?.roulette?.total,done:j.checkpoint?.roulette?.done,
                snapshotAt:j.checkpoint?.roulette?.snapshotAt},
              window:{cursor:j.checkpoint?.weekend?.cursor,total:j.checkpoint?.weekend?.total,done:j.checkpoint?.weekend?.done,
                snapshotAt:j.checkpoint?.weekend?.snapshotAt}}:{})}]))}));
        lastReport=Date.now();
      }
      if(result.status==='idle'){
        if(automated)break;
        await new Promise(resolve=>setTimeout(resolve,Math.min(15000,Math.max(1000,result.deadline-Date.now()))));
      }
    }
    // The loop only reaches here when it stops cleanly (budget reached, no due scheduled work,
    // or SIGTERM); a failed unit throws and skips straight to release. Daily selection has already
    // been checkpointed above when due, before any provider request.
    if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,
      `### Sequential collection session\n\nWave: ${wave}. Provider requests: ${provider.requests}. Main passes attempted: ${engine.state.completedMain}.\n\n`+
      Object.entries(engine.state.jobs).map(([task,j])=>`- ${task}: ${j.done?'pass finished':'checkpoint saved'}; ${j.checkpoint?.cursor??0}/${j.checkpoint?.total??'?'} units; ${j.checkpoint?.errors??0} inconclusive responses.\n`).join('')+
      "\nA successful session is not a claim that the day's main pass or all fast refreshes met their deadlines. Check pass timestamps and error counts.\n");
  }finally{
    process.off('SIGTERM',stop);process.off('SIGINT',stop);
    console.log(JSON.stringify(egressSummary()));
    if(claimed)await store.release();
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const secrets=['TP_TOKEN','SUPABASE_SERVICE_KEY','GITHUB_TOKEN'].map(k=>process.env[k]).filter(Boolean);
  for(const method of ['log','warn','error']){const original=console[method].bind(console);console[method]=(...args)=>original(...args.map(a=>{
    let text=typeof a==='string'?a:JSON.stringify(a);for(const secret of secrets)text=text.replaceAll(secret,'[redacted]');return text;
  }));}
  main().catch(error=>{console.error('Sequential collection stopped:',error.message);process.exitCode=1;});
}
