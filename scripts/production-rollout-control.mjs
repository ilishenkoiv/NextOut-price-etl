import { mkdir, writeFile } from 'node:fs/promises';
import { gzipSync, gunzipSync } from 'node:zlib';

const action=process.env.ROLLOUT_ACTION;
const url=(process.env.SUPABASE_URL||'').replace(/\/$/,'');
const key=process.env.SUPABASE_SERVICE_KEY;
if(!['probe','backup','restore'].includes(action)||!url||!key)throw new Error('Invalid rollout control configuration');
const headers={apikey:key,Authorization:`Bearer ${key}`,Accept:'application/json'};
const outputDir='rollout-output';await mkdir(outputDir,{recursive:true});
async function jsonFetch(path,init={}){const response=await fetch(url+path,{...init,headers:{...headers,...init.headers},signal:AbortSignal.timeout(30000)});
  const text=await response.text();let body=null;try{body=text?JSON.parse(text):null;}catch{body={nonJson:true};}
  if(!response.ok)throw new Error(`${path} failed (${response.status})`);return{response,body};}
async function maybeCount(table){const response=await fetch(`${url}/rest/v1/${table}?select=*&limit=0`,{method:'HEAD',headers:{...headers,Prefer:'count=exact'},signal:AbortSignal.timeout(30000)});
  if(response.status===404)return{missing:true};if(!response.ok)return{errorStatus:response.status};const range=response.headers.get('content-range')||'';return{count:Number(range.split('/')[1])};}
async function loadRows(table,columns,order,filter=''){const rows=[];for(let offset=0;;offset+=1000){const path=`/rest/v1/${table}?select=${encodeURIComponent(columns)}&order=${encodeURIComponent(order)}&offset=${offset}&limit=1000${filter}`;
  const {body}=await jsonFetch(path);if(!Array.isArray(body))throw new Error(`${table} inspection is not an array`);rows.push(...body);if(body.length<1000)return rows;}}
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
const now=Date.now(),recentIso=new Date(now-30*60*1000).toISOString(),today=new Date(now).toLocaleDateString('en-CA',{timeZone:'Europe/Berlin'});
const addDays=(iso,n)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10);};
const addMonths=(iso,n)=>{const d=new Date(iso+'T00:00:00Z');d.setUTCMonth(d.getUTCMonth()+n);return d.toISOString().slice(0,10);};
const schedulerRows=await loadRows('collection_scheduler_state','singleton,owner,run_id,fence,lease_until,checkpoint,updated_at','singleton.asc');
const recentPrices=await loadRows('prices','origin,dest,month,direct,any_stops,updated_at,price_source','origin.asc,dest.asc,month.asc',`&updated_at=gte.${encodeURIComponent(recentIso)}`);
const recentWindows=await loadRows('window_prices','origin,dest,flight_type,departure_at,return_at,updated_at,price_source','origin.asc,dest.asc,flight_type.asc,departure_at.asc,return_at.asc',`&updated_at=gte.${encodeURIComponent(recentIso)}`);
const allWindows=await loadRows('window_prices','origin,dest,flight_type,departure_at,return_at,updated_at,window_kind','origin.asc,dest.asc,flight_type.asc,departure_at.asc,return_at.asc');
const health=counts.route_price_health?.missing?[]:await loadRows('route_price_health','origin,dest,status,first_confirmed_no_price_at,last_price_at,updated_at','origin.asc,dest.asc');
const pool=await loadRows('daily_origin_cheapest_pool','snapshot_at,observed_on,origin,flight_type,rank,dest','snapshot_at.asc,origin.asc,flight_type.asc,rank.asc');
const poolGroups={};for(const row of pool){poolGroups[row.snapshot_at]=(poolGroups[row.snapshot_at]??0)+1;}
const consumer=allWindows.filter(row=>row.departure_at>=addDays(today,10)&&row.departure_at<=addMonths(today,4)&&row.return_at>row.departure_at&&['weekend','holiday'].includes(row.window_kind));
const ages=consumer.map(row=>now-Date.parse(row.updated_at)).filter(Number.isFinite);
probe.liveMetrics={recentSince:recentIso,recentPrices:recentPrices.length,recentPricesBothVariants:recentPrices.filter(r=>r.direct!=null&&r.any_stops!=null).length,
  recentPricesVariantProvenance:recentPrices.filter(r=>r.price_source?.variants&&(r.price_source.variants.direct||r.price_source.variants.any)).length,
  recentWindows:recentWindows.length,consumerWindowRows:consumer.length,
  consumerWindowGroups:new Set(consumer.map(r=>[r.origin,r.dest,r.departure_at,r.return_at].join('|'))).size,
  consumerOldestAgeMs:ages.length?Math.max(...ages):null,consumerNewestAgeMs:ages.length?Math.min(...ages):null,
  routeHealthRows:health.length,routeHealthDead:health.filter(r=>r.status==='dead').length,routeHealthWithPrice:health.filter(r=>r.last_price_at).length,
  poolRows:pool.length,poolSnapshots:Object.keys(poolGroups).length,latestPoolSnapshot:Object.keys(poolGroups).sort().at(-1)??null,
  latestPoolRows:Object.keys(poolGroups).length?poolGroups[Object.keys(poolGroups).sort().at(-1)]:0,schedulerRow:schedulerRows[0]??null};
if(process.env.BACKUP_PREFIX){
  const object=`${process.env.BACKUP_PREFIX}/daily_origin_cheapest_pool.json.gz`;
  const response=await fetch(`${url}/storage/v1/object/authenticated/price-snapshots/${object}`,{headers,signal:AbortSignal.timeout(120000)});
  if(!response.ok)throw new Error(`backup pool download failed (${response.status})`);
  const backup=JSON.parse(gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8')).rows;
  const pk=row=>[row.snapshot_at,row.origin,row.flight_type,row.rank].join('|');const currentKeys=new Set(pool.map(pk)),backupKeys=new Set(backup.map(pk));
  const missing=backup.filter(row=>!currentKeys.has(pk(row)));const added=pool.filter(row=>!backupKeys.has(pk(row)));
  const latestBackupSnapshot=backup.map(r=>r.snapshot_at).sort().at(-1)??null;const missingLatest=missing.filter(r=>r.snapshot_at===latestBackupSnapshot);
  const offers=await loadRows('offers','origin,dest,flight_type,departure_at,return_at','origin.asc,dest.asc,month.asc,flight_type.asc,departure_at.asc,return_at.asc');
  const offerKeys=new Set(offers.map(r=>[r.origin,r.dest,r.flight_type,r.departure_at,r.return_at].join('|')));
  probe.liveMetrics.poolBackupComparison={backupRows:backup.length,missingRows:missing.length,addedRows:added.length,
    latestBackupSnapshot,missingLatestRows:missingLatest.length,missingLatestWithoutOffer:missingLatest.filter(r=>!offerKeys.has([r.origin,r.dest,r.flight_type,r.departure_at,r.return_at].join('|'))).length};
}
await writeFile(`${outputDir}/probe.json`,JSON.stringify(probe,null,2));
console.log(JSON.stringify({event:'production_probe',counts,schedulerOwner:scheduler?.owner??null,
  schedulerLeaseUntil:scheduler?.lease_until??null,privateSnapshotBucket:probe.privateSnapshotBucket,
  rpcCount:rpcNames.length,adminRpcCandidates,liveMetrics:{...probe.liveMetrics,schedulerRow:probe.liveMetrics.schedulerRow?{
    owner:probe.liveMetrics.schedulerRow.owner,run_id:probe.liveMetrics.schedulerRow.run_id,fence:probe.liveMetrics.schedulerRow.fence,
    lease_until:probe.liveMetrics.schedulerRow.lease_until,updated_at:probe.liveMetrics.schedulerRow.updated_at}:null}}));
if(action==='backup'){
  const prefix=`rollout-backups/${new Date().toISOString().replace(/[:.]/g,'-')}-${process.env.ROLLOUT_RUN_ID}`;
  const backed={};
  const order={prices:'origin.asc,dest.asc,month.asc',offers:'origin.asc,dest.asc,month.asc,flight_type.asc,departure_at.asc,return_at.asc',
    window_prices:'origin.asc,dest.asc,flight_type.asc,departure_at.asc,return_at.asc',window_price_misses:'origin.asc,dest.asc,flight_type.asc,departure_at.asc,return_at.asc',
    daily_origin_cheapest:'observed_on.asc,origin.asc,flight_type.asc',daily_origin_cheapest_pool:'snapshot_at.asc,origin.asc,flight_type.asc,rank.asc',
    collection_scheduler_state:'singleton.asc',flight_price_feedback:'id.asc',flight_price_audits:'feedback_id.asc',route_price_health:'origin.asc,dest.asc',
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
if(action==='restore'){
  if(!process.env.BACKUP_PREFIX)throw new Error('Missing backup prefix');
  const conflicts={prices:'origin,dest,month',offers:'origin,dest,month,flight_type,departure_at,return_at',
    window_prices:'origin,dest,flight_type,departure_at,return_at',window_price_misses:'origin,dest,flight_type,departure_at,return_at',
    daily_origin_cheapest:'observed_on,origin,flight_type',daily_origin_cheapest_pool:'snapshot_at,origin,flight_type,rank'};
  const restored={};
  for(const [table,onConflict] of Object.entries(conflicts)){
    const object=`${process.env.BACKUP_PREFIX}/${table}.json.gz`;const download=await fetch(`${url}/storage/v1/object/authenticated/price-snapshots/${object}`,{headers,signal:AbortSignal.timeout(120000)});
    if(!download.ok)throw new Error(`restore download failed for ${table} (${download.status})`);
    const rows=JSON.parse(gunzipSync(Buffer.from(await download.arrayBuffer())).toString('utf8')).rows;
    for(let from=0;from<rows.length;from+=250){const response=await fetch(`${url}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`,{
      method:'POST',headers:{...headers,'Content-Type':'application/json',Prefer:'resolution=merge-duplicates,return=minimal'},body:JSON.stringify(rows.slice(from,from+250)),signal:AbortSignal.timeout(120000)});
      if(!response.ok)throw new Error(`restore upsert failed for ${table} at ${from} (${response.status})`);}
    restored[table]=rows.length;
  }
  await writeFile(`${outputDir}/restore-result.json`,JSON.stringify({backupPrefix:process.env.BACKUP_PREFIX,restored,completedAt:new Date().toISOString()},null,2));
  console.log(JSON.stringify({event:'production_restore_upsert_complete',backupPrefix:process.env.BACKUP_PREFIX,restored,
    schedulerRestored:false,rowsDeleted:false}));
}
