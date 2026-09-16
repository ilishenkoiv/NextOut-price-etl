// Read-only deployment check: no lease claim, no price request and no DDL/DML.
import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';
export async function main(env=process.env){
  if(!env.SUPABASE_SERVICE_KEY)throw new Error('Missing Supabase service credential');
  const url=env.SUPABASE_URL||'https://xpalogebawoljlafsafs.supabase.co';
  const db=createClient(url,env.SUPABASE_SERVICE_KEY,{auth:{persistSession:false,autoRefreshToken:false},
    global:{fetch:(input,init={})=>fetch(input,{...init,signal:AbortSignal.timeout(15000)})}});
  const inspected=await db.rpc('collection_state_inspect');
  if(inspected.error)throw new Error(`State read failed (${inspected.error.code??'unknown'})`);
  const bucket=await db.storage.getBucket('price-snapshots');
  if(bucket.error||!bucket.data||bucket.data.public!==false)throw new Error('Private snapshot bucket not confirmed');
  for(const [table,columns] of [
    ['prices','origin,market,dest,month,direct,any_stops,updated_at,price_source'],
    ['offers','origin,market,dest,month,flight_type,departure_at,return_at,nights,price,transfers,airline,updated_at,in_cheap_pool,target_nights,target_exact,target_actual_nights,in_break_window,price_source'],
    ['window_prices','origin,market,dest,flight_type,departure_at,return_at,window_kind,price_source'],
    ['window_price_misses','origin,market,dest,flight_type,departure_at,return_at,window_kind,outcome,checked_at'],
    ['daily_origin_cheapest_pool','snapshot_at,origin,flight_type,rank,price_source'],
  ]){
    const result=await db.from(table).select(columns).limit(0);
    if(result.error)throw new Error(`${table} schema read failed (${result.error.code??'unknown'})`);
  }
  // OpenAPI is metadata, not a call to any mutating RPC.
  const response=await fetch(url+'/rest/v1/',{headers:{apikey:env.SUPABASE_SERVICE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_KEY},signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new Error(`RPC metadata unavailable (${response.status})`);
  const schema=await response.json();
  const functions=['collection_state_inspect','collection_state_claim','collection_state_renew','collection_state_save','collection_state_release','collection_commit_main','collection_commit_window','collection_commit_roulette'];
  for(const name of functions)if(!schema.paths?.['/rpc/'+name])throw new Error(`Missing RPC metadata: ${name}`);
  console.log(JSON.stringify({ready:true,privateBucket:true,rpcCount:functions.length,priceSchemas:true,
    previousRunner:inspected.data?.run_id??null,leaseClaimed:false,providerRequests:0}));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)
  main().catch(error=>{console.error('Collection readiness failed:',error.message);process.exitCode=1;});
