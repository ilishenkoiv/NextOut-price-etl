import { randomUUID } from 'node:crypto';
import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createClient } from '@supabase/supabase-js';
import { CollectionStore, oldRunnerHasStopped } from './collection-store.mjs';
import { CollectionProvider } from './collection-provider.mjs';
import { SequentialSchedule, freshScheduleState } from './collection-schedule.mjs';
import { createAdapters } from './collection-adapters.mjs';
import { expansionTargets } from '../src/data/expansion-targets.js';
import { main as publishSnapshot } from './snapshot-daily-origin-cheapest.mjs';

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

// Decouples pool publication from FULL main-pass completion. The main pass is now
// larger than one Berlin day's collection budget (total ~13.5k route*month cells vs
// ~2–3k committed per session), so it reaches `done` — and republishes the roulette
// pool — only once every ~1.5–2 days. Between those completions the newest snapshot
// stays frozen and a later roulette re-verification can prune an offer the frozen pool
// still points at, producing the user-visible desync.
//
// At the end of every session that did NOT already publish through a completed main
// pass, and only while this runner still holds the fenced collection lease, rebuild the
// pool from the CURRENT fresh offers. snapshot-daily-origin-cheapest enforces
// pool ⊆ offers by construction, so every published candidate has a live offer no matter
// how far the in-progress main pass got. Safety properties:
//  - single writer: runs AFTER the sequential loop has stopped, on the same lease — no
//    concurrent request and no lease override;
//  - fenced: the lease is re-checked (and renewed) immediately before and after publish;
//  - no false success: publication is independently read back, and any failure throws so
//    a session can never report a publication that did not land;
//  - no partial state: the publisher writes a complete new snapshot_at set or fails; a
//    failed collection loop throws before reaching here, so a failed session never
//    publishes;
//  - no repeated manual republish: this is the automatic replacement for it.
// A session should publish an end-of-session pool only when a completed main pass did
// NOT already publish during it. `completedMain` is incremented by the scheduler exactly
// when the main adapter returns `done` (which is what publishes via the adapter), so an
// unchanged counter means the pass is still partial/resumed and the pool would otherwise
// stay frozen for this whole session.
export function shouldPublishEndOfSession(completedMainBefore, completedMainAfter) {
  return completedMainAfter === completedMainBefore;
}

export async function publishEndOfSessionPool({ db, lease, snapshotWave = 0, clock = Date.now, publish = publishSnapshot, log = () => {} }) {
  if (!await lease()) throw new Error('End-of-session pool publish forbidden: lease lost');
  const snapshotAt = new Date(clock()).toISOString();
  await publish({ db, snapshotAt, expansionWave: snapshotWave });
  if (!await lease()) throw new Error('End-of-session pool publish forbidden: lease lost after publish');
  const { data, error } = await db.from('daily_origin_cheapest_pool')
    .select('snapshot_at').eq('snapshot_at', snapshotAt).limit(1);
  if (error) throw new Error(`End-of-session pool readback failed: ${error.message ?? 'unknown error'}`);
  if (!data || data.length === 0) throw new Error('End-of-session pool publish was not confirmed by readback');
  log(JSON.stringify({ event: 'pool_republished_end_of_session', snapshotAt }));
  return { published: true, snapshotAt };
}

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
  let engine;
  engine=new SequentialSchedule({state,lease:()=>store.lease(),save:s=>store.save(s),stopAt:end,
    handlers:createAdapters({db,store,provider,wave,setDbDeadline:value=>{dbDeadline=value;},getState:()=>engine?.state})});
  let stopping=false;const stop=()=>{stopping=true;};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  let lastReport=0;
  const completedMainBefore=engine.state.completedMain;
  try{
    while(!stopping&&Date.now()+45000<end){
      const result=await engine.tick();
      if(Date.now()-lastReport>60000||result.status==='done'){
        console.log(JSON.stringify({task:result.task,status:result.status,cycle:result.cycle,providerRequests:provider.requests,
          completedMain:engine.state.completedMain,missedFast:engine.state.missedFast,
          progress:Object.fromEntries(Object.entries(engine.state.jobs).map(([k,j])=>[k,{done:j.done,cursor:j.checkpoint?.cursor,total:j.checkpoint?.total,errors:j.checkpoint?.errors}]))}));
        lastReport=Date.now();
      }
      if(result.status==='idle')await new Promise(resolve=>setTimeout(resolve,Math.min(15000,Math.max(1000,result.deadline-Date.now()))));
    }
    // The loop only reaches here when it stops cleanly (budget reached or SIGTERM); a
    // failed unit throws and skips straight to release, so a broken session never
    // publishes. If a completed main pass already republished this session, skip — the
    // adapter's completion publish is authoritative and re-publishing would be redundant.
    if(shouldPublishEndOfSession(completedMainBefore,engine.state.completedMain)){
      await publishEndOfSessionPool({db,lease:()=>store.lease(),
        snapshotWave:Number(env.SNAPSHOT_EXPANSION_WAVE??0),log:(...a)=>console.log(...a)});
    }
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
