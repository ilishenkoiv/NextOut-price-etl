import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

const action=process.env.ROLLOUT_ACTION;
const url=(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const key=process.env.SUPABASE_SERVICE_KEY;
if(!['probe','backup'].includes(action)||!url||!key)throw new Error('Invalid rollout control configuration');
const headers={apikey:key,Authorization:`Bearer ${key}`,Accept:'application/json'};
const outputDir='rollout-output';await mkdir(outputDir,{recursive:true});
async function jsonFetch(path,init={}){const response=await fetch(url+path,{...init,headers:{...headers,...init.headers},signal:AbortSignal.timeout(30000)});
  const text=await response.text();let body=null;try{body=text?JSON.parse(text):null;}catch{body={nonJson:true};}
  if(!response.ok)throw new Error(`${path} failed (${response.status})`);return{response,body};}
async function maybeCount(table){const response=await fetch(`${url}/rest/v1/${table}?select=*&limit=0`,{method:'HEAD',headers:{...headers,Prefer:'count=exact'},signal:AbortSignal.timeout(30000)});
  if(response.status===404)return{missing:true};if(!response.ok)return{errorStatus:response.status};const range=response.headers.get('content-range')||'';return{count:Number(range.split('/')[1])};}
const openapi=await jsonFetch('/rest/v1/');
const rpcNames=Object.keys(openapi.body.paths??{}).filter(p=>p.startsWith('/rpc/')).map(p=>p.slice(5)).sort();
const adminRpcCandidates=rpcNames.filter(n=>/sql|exec|query|admin|ddl|migration/i.test(n));
const tables=['prices','offers','window_prices','window_price_misses','daily_origin_cheapest','daily_origin_cheapest_pool',
  'collection_scheduler_state','flight_price_feedback','flight_price_audits','route_price_health','daily_cheapest_selection_runs'];
const counts={};for(const table of tables)counts[table]=await maybeCount(table);
let scheduler=null;try{scheduler=(await jsonFetch('/rest/v1/rpc/collection_state_inspect',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).body;}catch(error){scheduler={error:error.message};}
let bucket=null;try{bucket=(await jsonFetch('/storage/v1/bucket/price-snapshots')).body;}catch(error){bucket={error:error.message};}
const probe={action,runId:process.env.ROLLOUT_RUN_ID,at:new Date().toISOString(),counts,scheduler,
  privateSnapshotBucket:Boolean(bucket&&bucket.public===false),rpcNames,adminRpcCandidates};
await writeFile(`${outputDir}/probe.json`,JSON.stringify(probe,null,2));
console.log(JSON.stringify({event:'production_probe',counts,schedulerOwner:scheduler?.owner??null,
  schedulerLeaseUntil:scheduler?.lease_until??null,privateSnapshotBucket:probe.privateSnapshotBucket,
  rpcCount:rpcNames.length,adminRpcCandidates}));
if(action==='backup'){
  const prefix=`rollout-backups/${new Date().toISOString().replace(/[:.]/g,'-')}-${process.env.ROLLOUT_RUN_ID}`;
  const backed={};
  const order={prices:'origin.asc,dest.asc,month.asc',offers:'origin.asc,dest.asc,month.asc,flight_type.asc,departure_at.asc,return_at.asc',
    window_prices:'origin.asc,dest.asc,flight_type.asc,departure_at.asc,return_at.asc',window_price_misses:'origin.asc,dest.asc,flight_type.asc,departure_at.asc,return_at.asc',
    daily_origin_cheapest:'observed_on.asc,origin.asc,flight_type.asc',daily_origin_cheapest_pool:'snapshot_at.asc,origin.asc,flight_type.asc,rank.asc',
    collection_scheduler_state:'singleton.asc',flight_price_feedback:'id.asc',flight_price_audits:'id.asc',route_price_health:'origin.asc,dest.asc',
    daily_cheapest_selection_runs:'observed_on.asc'};
  for(const table of tables.filter(t=>!counts[t]?.missing)){
    const rows=[];for(let from=0;;from+=1000){const {body}=await jsonFetch(`/rest/v1/${table}?select=*&order=${order[table]}&offset=${from}&limit=1000`);
      if(!Array.isArray(body))throw new Error(`${table} backup is not an array`);rows.push(...body);if(body.length<1000)break;}
    const data=gzipSync(JSON.stringify({table,rows}));
    const object=`${prefix}/${table}.json.gz`;const up=await fetch(`${url}/storage/v1/object/price-snapshots/${object}`,{method:'POST',headers:{...headers,'Content-Type':'application/gzip','x-upsert':'false'},body:data,signal:AbortSignal.timeout(120000)});
    if(!up.ok)throw new Error(`backup upload failed for ${table} (${up.status})`);backed[table]={rows:rows.length,object};
  }
  const manifest={prefix,createdAt:new Date().toISOString(),sourceRunId:process.env.ROLLOUT_RUN_ID,counts,backed};
  const manifestBytes=Buffer.from(JSON.stringify(manifest,null,2));const upload=await fetch(`${url}/storage/v1/object/price-snapshots/${prefix}/manifest.json`,{method:'POST',headers:{...headers,'Content-Type':'application/json','x-upsert':'false'},body:manifestBytes,signal:AbortSignal.timeout(30000)});
  if(!upload.ok)throw new Error(`backup manifest upload failed (${upload.status})`);
  await writeFile(`${outputDir}/backup-manifest.json`,JSON.stringify(manifest,null,2));
  await writeFile(`${outputDir}/restore-procedure.txt`,`Restore requires coordinator stopped and migration-compatible code. Read manifest, load each private gzip object, and upsert by the table primary key; never truncate. Restore scheduler singleton last only after confirming no live lease. Code/config rollback target is recorded separately. Prefix: ${prefix}\n`);
  console.log(JSON.stringify({event:'production_backup_complete',prefix,tables:Object.fromEntries(Object.entries(backed).map(([t,v])=>[t,v.rows]))}));
}
