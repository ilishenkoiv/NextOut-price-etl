import test from 'node:test';
import assert from 'node:assert/strict';
import {withSupabaseRetry,canCheckpointWindow,retryMetadataFetch} from './supabase-retry.mjs';
import {createClient} from '@supabase/supabase-js';

test('real PostgREST builder preserves Retry-After and uses only the outer attempts',async()=>{
  let calls=0;const waits=[];
  const request=async()=>++calls===1?new Response('Gateway Timeout',{status:504,headers:{'retry-after':'3'}}):new Response('[{"airport":"VIE"}]',{status:200});
  const client=createClient('https://example.supabase.co','test',{global:{fetch:(url,init)=>retryMetadataFetch(url,init,request)},auth:{persistSession:false}});
  const result=await withSupabaseRetry(()=>client.from('origin_regions').select('airport'),{random:()=>0,sleep:async ms=>waits.push(ms),warn:()=>{}});
  assert.equal(calls,2);assert.deepEqual(waits,[3000]);assert.equal(result.data[0].airport,'VIE');
});
test('temporary 504 retries a fresh operation and preserves the successful result',async()=>{
  let calls=0;const waits=[];const result=await withSupabaseRetry(async()=>++calls<3?{status:504,error:{message:'Gateway Timeout'}}:{data:[1],error:null},{random:()=>0,sleep:async ms=>waits.push(ms),warn:()=>{}});
  assert.equal(calls,3);assert.deepEqual(waits,[1000,3000]);assert.deepEqual(result.data,[1]);
});
test('429 honors Retry-After and logs recovery without response secrets',async()=>{
  let calls=0;const waits=[],logs=[];
  await withSupabaseRetry(async()=>++calls===1?{status:429,error:{message:'secret-token'},headers:new Headers({'retry-after':'5'})}:{data:[1]},
    {label:'origin_regions read',random:()=>1,sleep:async ms=>waits.push(ms),warn:m=>logs.push(m)});
  assert.deepEqual(waits,[5000]);assert.match(logs.join('\n'),/HTTP 429/);assert.match(logs.join('\n'),/recovered/);assert.doesNotMatch(logs.join('\n'),/secret-token/);
});
test('long Retry-After defers instead of retrying early',async()=>{
  let calls=0;await withSupabaseRetry(async()=>{calls++;return {status:429,error:{retryAfter:'120'}};},{sleep:async()=>assert.fail(),warn:()=>{}});assert.equal(calls,1);
});
test('schema/permission errors do not create retry storms',async()=>{
  let calls=0;const result=await withSupabaseRetry(async()=>{calls++;return {status:403,error:{code:'42501',message:'permission denied'}};},{sleep:async()=>assert.fail(),warn:()=>{}});assert.equal(calls,1);assert.equal(result.error.code,'42501');
});
test('DNS transport retries are bounded and final failure remains visible',async()=>{
  let calls=0;await assert.rejects(()=>withSupabaseRetry(async()=>{calls++;throw new TypeError('DNS resolution error');},{delays:[1,2],sleep:async()=>{},warn:()=>{}}),/DNS/);assert.equal(calls,3);
});
test('empty provider answers complete a sweep, technical failures never do',()=>{
  assert.equal(canCheckpointWindow(new Set(['found','empty'])),true);
  assert.equal(canCheckpointWindow(new Set(['found','network_error','empty'])),false);
  assert.equal(canCheckpointWindow(new Set(['http_error','found'])),false);
  assert.equal(canCheckpointWindow(new Set(['unexpected'])),false);
});
