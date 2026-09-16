import test from 'node:test';
import assert from 'node:assert/strict';
import { CollectionProvider, CollectionYield } from './collection-provider.mjs';
import { oldRunnerHasStopped } from './collection-store.mjs';

test('pacing uses request start, preserves market, moves token to a header',async()=>{
  let now=0;const starts=[];
  const provider=new CollectionProvider({token:'private-test',clock:()=>now,sleep:async ms=>{now+=ms;},lease:async()=>true,
    fetchImpl:async(url,options)=>{assert.equal(new URL(url).searchParams.get('token'),null);assert.equal(new URL(url).searchParams.get('market'),'de');assert.equal(options.headers['X-Access-Token'],'private-test');starts.push(now);now+=50;return new Response('{"success":true,"data":[]}');}});
  await provider.request('https://api.travelpayouts.com/aviasales/v3/prices_for_dates?market=de&token=private-test');
  await provider.request('https://api.travelpayouts.com/aviasales/v3/prices_for_dates?market=de');
  assert.deepEqual(starts,[0,125]);
});
test('429 Retry-After is observed and cannot run into the next priority window',async()=>{
  let now=0,calls=0;
  const provider=new CollectionProvider({token:'test',clock:()=>now,sleep:async ms=>{now+=ms;},lease:async()=>true,
    fetchImpl:async()=>{calls++;return new Response('',{status:429,headers:{'Retry-After':'60'}});}});
  await assert.rejects(provider.request('https://api.travelpayouts.com/aviasales/v3/prices_for_dates',30000),CollectionYield);
  assert.equal(calls,1);
});
test('lease loss prevents a provider request',async()=>{
  let calls=0;
  const provider=new CollectionProvider({token:'test',lease:async()=>false,fetchImpl:async()=>{calls++;}});
  await assert.rejects(provider.request('https://api.travelpayouts.com/aviasales/v3/prices_for_dates'),/lease/);
  assert.equal(calls,0);
});
test('foreign hosts never receive the provider credential',async()=>{
  const provider=new CollectionProvider({token:'test',lease:async()=>true,fetchImpl:()=>{throw Error('must not fetch');}});
  await assert.rejects(provider.request('https://example.com'),/origin/);
});
test('expiry alone and unavailable GitHub are not evidence the old runner stopped',async()=>{
  const previous={owner:'old',run_id:'123',lease_until:'2026-09-16T00:00:00Z'};
  const opts={repository:'owner/repo',token:'test',now:Date.parse('2026-09-16T01:00:00Z')};
  assert.equal(await oldRunnerHasStopped(previous,{...opts,fetchImpl:async()=>new Response('{"status":"in_progress"}')}),false);
  assert.equal(await oldRunnerHasStopped(previous,{...opts,fetchImpl:async()=>new Response('',{status:503})}),false);
  assert.equal(await oldRunnerHasStopped(previous,{...opts,fetchImpl:async()=>new Response('{"status":"completed"}')}),true);
});
