import test from 'node:test';
import assert from 'node:assert/strict';
import {withSupabaseRetry,canCheckpointWindow} from './supabase-retry.mjs';
test('temporary 504 retries a fresh operation and preserves the successful result',async()=>{
  let calls=0;const waits=[];const result=await withSupabaseRetry(async()=>++calls<3?{status:504,error:{message:'Gateway Timeout'}}:{data:[1],error:null},{sleep:async ms=>waits.push(ms),warn:()=>{}});
  assert.equal(calls,3);assert.deepEqual(waits,[1000,3000]);assert.deepEqual(result.data,[1]);
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
