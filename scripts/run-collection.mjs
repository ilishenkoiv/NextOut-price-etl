import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { CollectionStore, oldRunnerHasStopped } from './collection-store.mjs';
import { CollectionProvider } from './collection-provider.mjs';
import { SequentialSchedule, freshScheduleState, CYCLE_MS } from './collection-schedule.mjs';
import { createAdapters } from './collection-adapters.mjs';
import { expansionTargets } from '../src/data/expansion-targets.js';
import { main as publishDailyRoulette, berlinObservedOn, nightlySelectionDue } from './snapshot-daily-origin-cheapest.mjs';
import { main as publishDailyWindows } from './snapshot-daily-window-candidates.mjs';

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

export function scheduledCollectionDue(state, instant=Date.now()) {
  if(!state||state.version!==1||!state.jobs)return true;
  const cycle=Math.floor(instant/CYCLE_MS),priority=state.jobs.priority;
  const priorityDue=!priority||priority.id!==cycle||!priority.done;
  const day=berlinObservedOn(instant),selection=state.dailySelection;
  const selectionDue=nightlySelectionDue(instant)&&(
    selection?.day!==day||selection.rouletteDone!==true||selection.windowDone!==true);
  return priorityDue||selectionDue;
}

// Daily membership publication is now a checkpointed coordinator phase. It runs after the
// single database claim, verifies the lease before each idempotent once/day publication and
// fences each phase transition through CollectionStore.save. Manual selector workflows remain
// recovery-only; no independently scheduled selection writer exists.
export async function runDueDailySelection({state,store,db,wave=0,instant=Date.now(),
  publishRoulette=publishDailyRoulette,publishWindows=publishDailyWindows}={}) {
  if(!nightlySelectionDue(instant))return{state,published:false};
  const day=berlinObservedOn(instant),snapshotAt=new Date(instant).toISOString();
  const checkpoint=state.dailySelection?.day===day?structuredClone(state.dailySelection):{
    day,rouletteDone:false,windowDone:false,startedAt:instant};
  state.dailySelection=checkpoint;await store.save(state);
  let published=false;
  if(!checkpoint.rouletteDone){
    if(!await store.lease())throw new Error('Daily roulette selection forbidden: lease lost');
    const result=await publishRoulette({db,snapshotAt,expansionWave:wave});
    checkpoint.rouletteDone=true;checkpoint.roulettePublished=result?.rebuilt===true;checkpoint.rouletteCompletedAt=Date.now();
    await store.save(state);published ||= checkpoint.roulettePublished;
  }
  if(!checkpoint.windowDone){
    if(!await store.lease())throw new Error('Daily window selection forbidden: lease lost');
    const result=await publishWindows({db,instant,wave});
    checkpoint.windowDone=true;checkpoint.windowPublished=result?.published===true;checkpoint.windowCompletedAt=Date.now();
    await store.save(state);published ||= checkpoint.windowPublished;
    if(checkpoint.windowPublished&&state.jobs.priority){
      state.jobs.priority.done=false;state.jobs.priority.completedAt=null;
      if(state.jobs.priority.checkpoint)state.jobs.priority.checkpoint.phase='roulette';
      await store.save(state);
    }
  }
  checkpoint.completedAt=Date.now();await store.save(state);
  return{state,published};
}

export async function main(env=process.env){
  if(env.COLLECTION_MODE!=='coordinated')throw new Error('Coordinated mode has not been enabled');
  for(const key of ['TP_TOKEN','SUPABASE_SERVICE_KEY','GITHUB_TOKEN'])if(!env[key])throw new Error(`Missing required ${key}`);
  const wave=Number(env.EXPANSION_WAVE??0);expansionTargets(wave);
  const minutes=Number(env.COLLECTION_SESSION_MINUTES??25);
  if(!Number.isInteger(minutes)||minutes<1||minutes>240)throw new Error('Session must be 1–240 minutes');
  if(!await noOtherActiveRuns(env))throw new Error('Other active workflow or unknown GitHub state; no collection started');
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
    if(!await oldRunnerHasStopped(previous,{repository:env.GITHUB_REPOSITORY,token:env.GITHUB_TOKEN}))throw new Error('Old runner not confirmed stopped; refusing overlap');
    const state=await store.claim(previous?.owner??null)??freshScheduleState();claimed=true;
    if(state.version!==1||!state.jobs||typeof state.jobs!=='object')throw new Error('Unsupported stored checkpoint');
    if(env.GITHUB_EVENT_NAME==='schedule'&&!scheduledCollectionDue(state)){
      console.log(JSON.stringify({event:'collection_not_due',cycle:Math.floor(Date.now()/CYCLE_MS)}));return;
    }
    await runDueDailySelection({state,store,db,wave});
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
        if(env.GITHUB_EVENT_NAME==='schedule')break;
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
