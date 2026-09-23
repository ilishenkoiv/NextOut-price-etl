import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { CollectionStore, oldRunnerHasStopped } from './collection-store.mjs';
import { CollectionProvider } from './collection-provider.mjs';
import { SequentialSchedule, freshScheduleState } from './collection-schedule.mjs';
import { createAdapters } from './collection-adapters.mjs';
import { expansionTargets } from '../src/data/expansion-targets.js';

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

// Stage 3: the coordinator no longer performs selection. Rebuilding the roulette pool
// (membership/order/rank) is owned exclusively by the nightly selection workflow
// (`Nightly cheapest offers selection` → scripts/snapshot-daily-origin-cheapest.mjs), which
// runs once per Berlin day (~03:30) and is protected by an observed_on once-per-day guard.
// A session end here does NOT republish the pool: between nightly selections the coordinator
// priority refresh keeps the SELECTED tickets' prices fresh without changing membership,
// and the nightly owner (plus its post-coordinator catch-up trigger) re-selects at most once
// per day. This removes the former end-of-session republish, which was a second selection
// writer competing with the owner.
export async function main(env=process.env){
  if(env.COLLECTION_MODE!=='coordinated')throw new Error('Coordinated mode has not been enabled');
  for(const key of ['TP_TOKEN','SUPABASE_SERVICE_KEY','GITHUB_TOKEN'])if(!env[key])throw new Error(`Missing required ${key}`);
  const wave=Number(env.EXPANSION_WAVE??0);expansionTargets(wave);
  const minutes=Number(env.COLLECTION_SESSION_MINUTES??235);
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
  const previous=await store.inspect();
  if(!await oldRunnerHasStopped(previous,{repository:env.GITHUB_REPOSITORY,token:env.GITHUB_TOKEN}))throw new Error('Old runner not confirmed stopped; refusing overlap');
  const state=await store.claim(previous?.owner??null)??freshScheduleState();
  if(state.version!==1||!state.jobs||typeof state.jobs!=='object')throw new Error('Unsupported stored checkpoint');
  const end=Date.now()+minutes*60000;
  const provider=new CollectionProvider({token:env.TP_TOKEN,lease:()=>store.lease()});
  // The 30-minute schedule already assigns a nominal 180 minutes of a 235-minute session to MAIN.
  // The deadline guard is on unless explicitly rolled back; when measured progress is late it may
  // borrow TAIL, but never priority/FAST/maintenance.
  const guaranteeDailyMain=env.GUARANTEE_DAILY_MAIN!=='false';
  let engine;
  engine=new SequentialSchedule({state,lease:()=>store.lease(),save:s=>store.save(s),stopAt:end,guaranteeDailyMain,
    handlers:createAdapters({db,store,provider,wave,setDbDeadline:value=>{dbDeadline=value;},getState:()=>engine?.state})});
  let stopping=false;const stop=()=>{stopping=true;};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  let lastReport=0;
  try{
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
      if(result.status==='idle')await new Promise(resolve=>setTimeout(resolve,Math.min(15000,Math.max(1000,result.deadline-Date.now()))));
    }
    // The loop only reaches here when it stops cleanly (budget reached or SIGTERM); a
    // failed unit throws and skips straight to release. The session does NOT publish the
    // roulette pool: selection is the nightly owner's sole responsibility (see note above).
    if(env.GITHUB_STEP_SUMMARY)await appendFile(env.GITHUB_STEP_SUMMARY,
      `### Sequential collection session\n\nWave: ${wave}. Provider requests: ${provider.requests}. Main passes attempted: ${engine.state.completedMain}.\n\n`+
      Object.entries(engine.state.jobs).map(([task,j])=>`- ${task}: ${j.done?'pass finished':'checkpoint saved'}; ${j.checkpoint?.cursor??0}/${j.checkpoint?.total??'?'} units; ${j.checkpoint?.errors??0} inconclusive responses.\n`).join('')+
      "\nA successful session is not a claim that the day's main pass or all fast refreshes met their deadlines. Check pass timestamps and error counts.\n");
  }finally{
    process.off('SIGTERM',stop);process.off('SIGINT',stop);
    await store.release();
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const secrets=['TP_TOKEN','SUPABASE_SERVICE_KEY','GITHUB_TOKEN'].map(k=>process.env[k]).filter(Boolean);
  for(const method of ['log','warn','error']){const original=console[method].bind(console);console[method]=(...args)=>original(...args.map(a=>{
    let text=typeof a==='string'?a:JSON.stringify(a);for(const secret of secrets)text=text.replaceAll(secret,'[redacted]');return text;
  }));}
  main().catch(error=>{console.error('Sequential collection stopped:',error.message);process.exitCode=1;});
}
