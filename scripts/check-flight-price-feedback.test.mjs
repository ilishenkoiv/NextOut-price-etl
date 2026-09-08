import test from 'node:test';
import assert from 'node:assert/strict';
import { githubIsIdle, checkTicket, classifyResponse, ticketFromFeedback, WORKFLOW_NAME } from './check-flight-price-feedback.mjs';
import { withPriceProvenance } from './price-provenance.mjs';
import fs from 'node:fs';

const ticket={origin:'BER',dest:'PMI',depart:'2027-01-10',ret:'2027-01-17',mode:'direct'};
const fare={origin:'BER',destination:'PMI',departure_at:'2027-01-10T00:00:00Z',return_at:'2027-01-17T00:00:00Z',transfers:0,price:120};
test('exact dates, return, route, currency and direct variant cannot be substituted',()=>{
  assert.equal(classifyResponse({success:true,data:[fare]},ticket).price,120);
  for(const patch of [{departure_at:'2027-01-11'},{return_at:'2027-01-18'},{origin:'MUC'},{destination:'ALC'},{transfers:1}])
    assert.equal(classifyResponse({success:true,data:[{...fare,...patch}]},ticket).status,'no_result');
  assert.equal(classifyResponse({success:true,data:[{...fare,currency:'USD'}]},ticket).status,'error');
  assert.equal(classifyResponse({success:true,data:[{...fare,price:0}]},ticket).status,'error');
});
test('empty cache is inconclusive, not evidence that user was wrong',()=>{
  assert.deepEqual(classifyResponse({success:true,data:[]},ticket),{status:'no_result',detail:'no_exact_offer_in_provider_cache'});
  for(const body of [null,{success:false,data:[]},{success:true,data:{}}])assert.equal(classifyResponse(body,ticket).status,'error');
});
test('missing mode, past dates and one-way have no comparable round-trip check',()=>{
  const f={origin_iata:'BER',destination_iata:'PMI',depart_date:ticket.depart,return_date:ticket.ret,flight_type:'direct'};
  assert.ok(ticketFromFeedback(f,'2027-01-01'));
  assert.equal(ticketFromFeedback({...f,flight_type:null},'2027-01-01'),null);
  assert.equal(ticketFromFeedback({...f,return_date:null},'2027-01-01'),null);
  assert.equal(ticketFromFeedback(f,'2027-02-01'),null);
});
test('busy or unknown GitHub never calls provider',async()=>{
  let calls=0;
  const result=await checkTicket(ticket,{token:'secret',idle:async()=>false,fetchImpl:async()=>{calls++;}});
  assert.equal(calls,0);assert.equal(result.status,'pending');
  assert.equal(await githubIsIdle({}),false);
  assert.equal(await githubIsIdle({token:'x',repository:'o/r',runId:'1',fetchImpl:async()=>({ok:false})}),false);
});
test('all workflow types and queued jobs block low priority; only this workflow is excluded',async()=>{
  for(const name of ['Twice-daily price fetch','Carousel window prices','Any unrelated maintenance']){
    assert.equal(await githubIsIdle({token:'x',repository:'o/r',runId:'1',fetchImpl:async()=>({ok:true,json:async()=>({workflow_runs:[{id:2,name}]})})}),false);
  }
  let queries=0;
  assert.equal(await githubIsIdle({token:'x',repository:'o/r',runId:'1',fetchImpl:async()=>{queries++;return {ok:true,json:async()=>({workflow_runs:[{id:1,name:WORKFLOW_NAME}]})};}}),true);
  assert.equal(queries,5);
});
test('token is sent in header, never in URL; errors do not retain response bodies',async()=>{
  const result=await checkTicket(ticket,{token:'SECRET',idle:async()=>true,fetchImpl:async(url,options)=>{
    assert.ok(!url.includes('SECRET'));assert.equal(new URL(url).searchParams.get('market'),'de');assert.equal(options.headers['X-Access-Token'],'SECRET');
    return {ok:true,json:async()=>({success:true,data:[fare]})};
  }});
  assert.equal(result.status,'found');
});
test('new primary work interrupts an in-flight low-priority request and returns it to pending',async()=>{
  let checks=0;
  const result=await checkTicket(ticket,{token:'SECRET',idle:async()=>++checks===1,fetchImpl:(_url,{signal})=>new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(new Error('aborted'))))});
  assert.equal(result.status,'pending');assert.equal(result.detail,'yielded_to_primary_workflow');
});
test('provenance follows each row observation and does not mutate input',()=>{
  const row={price:120,updated_at:'2026-09-03T09:00:00Z',flight_type:'direct',market:'de'};
  const [out]=withPriceProvenance([row],'offers',{GITHUB_RUN_ID:'123',GITHUB_RUN_ATTEMPT:'2',GITHUB_WORKFLOW:'fetch',GITHUB_JOB:'month_1'});
  assert.equal(out.price_source.run_id,'123');assert.equal(out.price_source.run_attempt,2);
  assert.equal(out.price_source.observed_at,row.updated_at);assert.equal(row.price_source,undefined);
  assert.equal(out.price_source.market,'de');
});
test('nightly workflow runs once in Berlin and drains the queue instead of stopping at twelve',()=>{
  const workflow=fs.readFileSync(new URL('../.github/workflows/check-flight-price-feedback.yml',import.meta.url),'utf8');
  const worker=fs.readFileSync(new URL('./check-flight-price-feedback.mjs',import.meta.url),'utf8');
  assert.match(workflow,/cron: '47 4 \* \* \*'/);
  assert.match(workflow,/timezone: 'Europe\/Berlin'/);
  assert.match(workflow,/timeout-minutes: 120/);
  assert.match(workflow,/Process all accumulated feedback audits/);
  assert.match(worker,/for \(;;\)/);
  assert.doesNotMatch(worker,/i < 12/);
});
