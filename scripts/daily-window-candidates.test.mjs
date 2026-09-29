import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { main, manualRecoveryMain, selectDailyWindowCandidates } from './snapshot-daily-window-candidates.mjs';
import { DAILY_SELECTION_REFRESH_MAX_MS } from './daily-selection-budget.mjs';
import { attachCarouselSixMonthMinimum, buildCarouselSixMonthMinimum, chooseCarouselCityForWindow,
  preserveCarouselSixMonthMinimum } from './carousel-six-month-contract.mjs';

const snapshotAt='2026-09-22T04:00:00.000Z';
const row=(dest,flight_type,price,over={})=>({origin:'BER',dest,flight_type,departure_at:'2026-10-02',return_at:'2026-10-04',
  price,transfers:flight_type==='direct'?0:1,updated_at:'2026-09-22T03:45:00.000Z',price_source:{table:'window_prices'},...over});

test('daily server set publishes the complete positive exact union, including last-known rows, with deterministic order',()=>{
  const rows=[row('BCN','direct',200),row('BCN','any',150),row('FCO','any',100),row('ATH','any',300),
    row('VCE','any',80,{updated_at:'2026-09-19T00:00:00.000Z'})];
  const out=selectDailyWindowCandidates(rows,{today:'2026-09-22',snapshotAt,regions:['DE-BE']});
  assert.deepEqual(out.map(r=>[r.flight_type,r.dest,r.destination_id,r.exact_price,r.position]),[
    ['any','VCE','venice',80,1],['any','FCO','rome',100,2],['any','BCN','barcelona',150,3],['any','ATH','athens',300,4],['direct','BCN','barcelona',200,1],
  ]);
  assert.ok(out.every(r=>r.window_kind==='weekend'&&r.region_codes.length===0&&r.refresh_status==='fresh'));
});

test('any mode may use the cheaper observed direct row without dropping the independent direct candidate',()=>{
  const out=selectDailyWindowCandidates([row('BCN','direct',90),row('BCN','any',120)],{today:'2026-09-22',snapshotAt,regions:['DE-BE']});
  assert.deepEqual(out.map(r=>[r.flight_type,r.exact_price]),[['any',90],['direct',90]]);
});

test('selection fails closed for unknown identity, invalid observation, non-factual dates and unpublished expansion wave',()=>{
  const rows=[row('ZZZ','any',1),row('MAD','any',100),row('BCN','any',100,{departure_at:'2026-10-03',return_at:'2026-10-05'}),
    row('FCO','any',100,{updated_at:'not-an-instant'})];
  assert.deepEqual(selectDailyWindowCandidates(rows,{today:'2026-09-22',snapshotAt,regions:['DE-BE'],wave:0}),[]);
});

test('migration exposes atomic daily publication, fenced price-only refresh, read grants and recovery',()=>{
  const migration=readFileSync(new URL('../migrations/20260922140000_daily_window_candidates.sql',import.meta.url),'utf8');
  const verify=readFileSync(new URL('./verify-daily-window-candidates.sql',import.meta.url),'utf8');
  const rollback=readFileSync(new URL('./rollback-daily-window-candidates.sql',import.meta.url),'utf8');
  assert.match(migration,/pg_advisory_xact_lock/);assert.match(migration,/on conflict\(observed_on\) do nothing/);
  assert.match(migration,/daily_origin_cheapest_pool add column if not exists destination_id/);
  assert.match(migration,/"GVA":"chamonix"/);assert.match(migration,/"ZRH":"zermatt"/);
  assert.match(migration,/collection_scheduler_state[\s\S]*owner=p_owner[\s\S]*fence=p_token[\s\S]*for update/);
  assert.match(migration,/select c\.\* into stored_ticket[\s\S]*for update[\s\S]*t:=stored_ticket/);
  assert.match(migration,/refresh_status='unavailable'/);assert.match(migration,/refresh_status='failed'/);
  assert.match(migration,/grant select on public\.daily_window_candidate_epochs,public\.daily_window_candidates to anon,authenticated/);
  assert.match(verify,/same-price refresh did not update observation/);assert.match(verify,/technical failure erased\/freshened saved price/);
  assert.match(verify,/canonical destination identity mapping mismatch/);
  assert.match(verify,/rollback;\s*$/);assert.match(rollback,/rename to daily_window_candidates_rollback_20260922/);
});

test('status-contract repair changes only the publisher status predicate and provides an exact rollback',()=>{
  const repair=readFileSync(new URL('../migrations/20260927120000_publish_daily_window_candidate_statuses.sql',import.meta.url),'utf8');
  const rollback=readFileSync(new URL('./rollback-publish-daily-window-candidate-statuses.sql',import.meta.url),'utf8');
  const recoveryReadback=readFileSync(new URL('./readback-window-publication-recovery.sql',import.meta.url),'utf8');
  assert.match(repair,/coalesce\(r->>'refresh_status',''\) not in \('fresh','unavailable','failed'\)/);
  assert.match(rollback,/r->>'refresh_status'<>'fresh'/);
  for(const invariant of [/pg_advisory_xact_lock/,/invalid candidate ordering/,/exact_price/,/exact_observed_at/,/destination_id/,/aviasales_market_for_origin/]){
    assert.match(repair,invariant);assert.match(rollback,invariant);
  }
  assert.match(repair,/notify pgrst,'reload schema';\s*$/);assert.match(rollback,/notify pgrst,'reload schema';\s*$/);
  assert.match(recoveryReadback,/'priority_checkpoint'[\s\S]*checkpoint->'jobs'->'priority'/,
    'recovery readback must expose the priority weekend current-day/stale status');
});

test('window_prices date filtering stays server-side while an older positive row remains eligible',async()=>{
  const { main } = await import('./snapshot-daily-window-candidates.mjs');
  const instant = Date.parse('2026-09-22T04:00:00.000Z');
  const fresh = '2026-09-22T03:45:00.000Z';
  const allRows = [
    row('BCN','direct',200,{updated_at:fresh}),
    row('BCN','any',150,{updated_at:fresh}),
    row('FCO','any',100,{updated_at:fresh}),
    row('ATH','any',300,{updated_at:fresh}),
    // Last-known positive exact row: older than the former 36h cutoff and still eligible.
    row('VCE','any',80,{updated_at:'2026-09-19T00:00:00.000Z'}),
    // out of window: departs long after the 4-month horizon -> must be excluded
    row('MAD','any',90,{departure_at:'2027-06-01',return_at:'2027-06-03',updated_at:fresh}),
    // out of window: departs before the 10-day lead -> must be excluded
    row('LIS','any',70,{departure_at:'2026-09-25',return_at:'2026-09-27',updated_at:fresh}),
  ];
  let returnedRowCount = null;
  function serverTable(rows) {
    let data = rows.slice();
    const builder = {
      select(){return builder;},
      gte(col,val){data=data.filter(r=>String(r[col])>=val);return builder;},
      lte(col,val){data=data.filter(r=>String(r[col])<=val);return builder;},
      in(col,values){data=data.filter(r=>values.includes(r[col]));return builder;},
      eq(col,val){data=data.filter(r=>r[col]===val);return builder;},
      order(){return builder;},
      range(from,to){const page=data.slice(from,to+1);if(rows===allRows)returnedRowCount=page.length;return Promise.resolve({data:page,error:null});},
    };
    return builder;
  }
  const db = {
    from(table){
      if(table==='window_prices')return serverTable(allRows);
      if(table==='prices')return serverTable([]);
      if(table==='public_holidays')return serverTable([]);
      if(table==='origin_regions')return serverTable([{airport:'BER',calendar_subdivision_code:'DE-BE'}]);
      throw new Error('unexpected table '+table);
    },
    rpc(){throw new Error('rpc not stubbed for this call');},
  };
  let published=null;
  db.rpc=(name,args)=>{if(name!=='publish_daily_window_candidates')throw new Error('unexpected rpc '+name);published=args;return Promise.resolve({data:true,error:null});};
  await main({db,instant,force:true});
  assert.ok(returnedRowCount!==null && returnedRowCount<allRows.length,
    'the DB-side filter must already narrow the row set before it reaches JS (server-side filtering happened)');
  const expected = selectDailyWindowCandidates(allRows,{today:'2026-09-22',snapshotAt:new Date(instant).toISOString(),holidays:[],regions:['DE-BE'],
    originRegions:[{airport:'BER',calendar_subdivision_code:'DE-BE'}],wave:0});
  assert.deepEqual(published.p_candidates, expected,
    'server-side date filtering must preserve the same candidate set, including older positive exact rows');
});

test('manual recovery requires the provider credential and passes the shared bounded fail-closed contract',async()=>{
  await assert.rejects(()=>manualRecoveryMain({env:{},publish:async()=>{throw new Error('must not publish');}}),/requires TP_TOKEN/);
  const provider={request:async()=>({kind:'refused',refusal:'server'})};let options=null;
  const result=await manualRecoveryMain({env:{TP_TOKEN:'recovery-token'},clock:()=>1000,
    providerFactory:received=>{options=received;return provider;},
    publish:async received=>received});
  assert.equal(options.token,'recovery-token');assert.equal(await options.lease(),true);
  assert.equal(result.provider,provider);assert.equal(result.refreshDeadline,1000+DAILY_SELECTION_REFRESH_MAX_MS);
  assert.equal(result.requireCompleteRefresh,true);
  const workflow=readFileSync(new URL('../.github/workflows/nightly-cheapest-selection.yml',import.meta.url),'utf8');
  assert.match(workflow,/Select the shared daily weekend candidates[\s\S]*TP_TOKEN: \$\{\{ secrets\.TP_TOKEN \}\}[\s\S]*snapshot-daily-window-candidates\.mjs/);
});

test('manual recovery refuses a partial point-refresh before the publication RPC',async()=>{
  const handle=windowDb([row('BCN','any',150)]);let requested=0;
  await assert.rejects(()=>main({db:handle.db,instant:Date.parse('2026-09-22T04:00:00Z'),force:true,
    provider:{request:async()=>{requested++;return{kind:'refused',refusal:'server'};}},clock:()=>1000,
    refreshDeadline:1000,requireCompleteRefresh:true}),/refused incomplete point refresh \(0\/1\)/);
  assert.equal(requested,0);assert.equal(handle.published,null,'partial recovery must not call publish_daily_window_candidates');
});

// ---- Select -> point-refresh -> publish (no freshness wait) ---------------------------

function windowDb(rows,monthly=[]){
  function serverTable(data){
    const builder={select(){return builder;},gte(){return builder;},lte(){return builder;},eq(){return builder;},in(){return builder;},order(){return builder;},
      range:(from,to)=>Promise.resolve({data:data.slice(from,to+1),error:null})};
    return builder;
  }
  let published=null;
  const db={from:(table)=>table==='window_prices'?serverTable(rows):table==='prices'?serverTable(monthly):table==='origin_regions'?serverTable([{airport:'BER',calendar_subdivision_code:'DE-BE'}]):serverTable([]),
    rpc:(name,args)=>{published=args;return Promise.resolve({data:true,error:null});}};
  return {db,get published(){return published;}};
}

test('selection never waits for source freshness: publishes immediately from a stale source, freshness fraction is recorded but never blocks',async()=>{
  const { main } = await import('./snapshot-daily-window-candidates.mjs');
  const instant=Date.parse('2026-09-22T04:00:00.000Z');
  const stale=row('BCN','any',150,{updated_at:'2026-09-20T20:15:00.000Z'}); // within the 36h publish window but past the 3h freshness window
  const {db}=windowDb([stale]);
  const result=await main({db,instant,force:true});
  assert.equal(result.published,true,'publishes immediately despite a stale source');
  assert.ok(result.freshFraction<1,'the fraction reflects the stale source, but never blocked the publish');
});

test('point-refresh: given a provider, the selected candidate is confirmed via the exact-price endpoint before publish, and a found response overrides the bulk-selection price',async()=>{
  const { main } = await import('./snapshot-daily-window-candidates.mjs');
  const instant=Date.parse('2026-09-22T04:00:00.000Z');
  const fresh=row('BCN','any',150,{updated_at:'2026-09-22T03:45:00.000Z'});
  const monthly=[{origin:'BER',dest:'BCN',month:'2026-12',direct:110,any_stops:80,updated_at:'2026-09-22T02:00:00Z',
    price_source:{run_id:'5',variants:{any:{sample_offer:{departure_at:'2026-12-04',return_at:'2026-12-06',nights:2,price:80,flight_type:'any'}}}}}];
  const handle=windowDb([fresh],monthly);
  let requests=0;
  const confirmedRow={departure_at:'2026-10-02',return_at:'2026-10-04',price:99,transfers:1};
  const provider={request:async function(){ requests++; return {kind:'ok',json:{success:true,data:[confirmedRow]}}; }};
  await main({db:handle.db,instant,force:true,provider,refreshDeadline:Date.now()+120000});
  assert.ok(requests>0,'the provider was called to point-refresh the selected candidate');
  assert.ok(handle.published.p_candidates.some(c=>c.exact_price===99&&c.refresh_status==='fresh'),
    'the confirmed exact price (99) replaces the bulk-selection price (150) before publish');
  assert.equal(handle.published.p_candidates[0].price_source.carousel_six_month_min.price,80,
    'point refresh preserves the separate six-month minimum contract');
});

test('point-refresh: a no_result response marks the candidate unavailable without changing exact_price',async()=>{
  const { main } = await import('./snapshot-daily-window-candidates.mjs');
  const instant=Date.parse('2026-09-22T04:00:00.000Z');
  const fresh=row('BCN','any',150,{updated_at:'2026-09-22T03:45:00.000Z'});
  const handle=windowDb([fresh]);
  const provider={request:async()=>({kind:'ok',json:{success:true,data:[]}})};
  await main({db:handle.db,instant,force:true,provider,refreshDeadline:Date.now()+120000});
  assert.ok(handle.published.p_candidates.every(c=>c.exact_price===150),'the original bulk-selection price is preserved');
  assert.ok(handle.published.p_candidates.some(c=>c.refresh_status==='unavailable'),'the no_result candidate is marked unavailable');
});

test('point-refresh: a technical error is published as failed without erasing the historical price or observation',async()=>{
  const { main } = await import('./snapshot-daily-window-candidates.mjs');
  const instant=Date.parse('2026-09-22T04:00:00.000Z');
  const observed='2026-09-22T03:45:00.000Z';const fresh=row('BCN','any',150,{updated_at:observed});
  const handle=windowDb([fresh]);
  const provider={request:async()=>({kind:'refused',refusal:'server'})};
  await main({db:handle.db,instant,force:true,provider,refreshDeadline:Date.now()+120000});
  const failed=handle.published.p_candidates.find(c=>c.refresh_status==='failed');
  assert.equal(failed.exact_price,150);assert.equal(failed.exact_observed_at,observed);
  assert.equal(failed.last_error_kind,'point_refresh_error');
});

test('six-month minimum is separate from the exact ticket and carries winning month, real sample dates and provenance',()=>{
  const ticket={origin:'MUC',dest:'BCN',flight_type:'any',exact_price:142,price_source:{table:'window_prices',observed_at:'2026-09-29T04:00:00Z'}};
  const months=['2026-10','2026-11','2026-12','2027-01','2027-02','2027-03'];
  const rows=[
    {origin:'MUC',dest:'BCN',month:'2026-10',any_stops:115,updated_at:'2026-09-28T08:20:11Z',price_source:{run_id:'17',variants:{any:{sample_offer:{departure_at:'2026-10-17',return_at:'2026-10-20',nights:3,price:120,flight_type:'any'}}}}},
    {origin:'MUC',dest:'BCN',month:'2026-12',any_stops:99,updated_at:'2026-09-29T03:00:00Z',price_source:{run_id:'18',variants:{any:{sample_offer:{departure_at:'2026-12-24',return_at:'2026-12-27',nights:3,price:99,flight_type:'any'}}}}},
    {origin:'MUC',dest:'BCN',month:'2027-01',any_stops:105,updated_at:'2026-09-29T02:00:00Z',price_source:{variants:{any:{}}}},
  ];
  const minimum=buildCarouselSixMonthMinimum(ticket,rows,months);
  assert.deepEqual(minimum,{price:99,currency:'EUR',winning_month:'2026-12',horizon_start:'2026-10',horizon_end:'2027-03',source:'prices',
    observed_at:'2026-09-29T03:00:00Z',source_run_id:'18',sample_dates:{departure_at:'2026-12-24',return_at:'2026-12-27'}});
  const [published]=attachCarouselSixMonthMinimum([ticket],rows,months);
  assert.equal(published.exact_price,142);assert.equal(published.price_source.table,'window_prices');
  assert.equal(published.price_source.carousel_six_month_min.price,99);
  assert.equal(preserveCarouselSixMonthMinimum({table:'window_prices',observed_at:'2026-09-29T05:00:00Z'},published.price_source).carousel_six_month_min.winning_month,'2026-12');
});

test('MUC keeps November, DE-BY Christmas/New Year and January candidates without borrowing CH-GE',()=>{
  const old='2026-08-01T00:00:00Z',base={origin:'MUC',dest:'BCN',flight_type:'any',price:120,transfers:1,updated_at:old,price_source:{table:'window_prices'}};
  const rows=[
    {...base,departure_at:'2026-11-27',return_at:'2026-11-29'},
    {...base,departure_at:'2026-12-24',return_at:'2026-12-27'},
    {...base,departure_at:'2026-12-31',return_at:'2027-01-03'},
    {...base,departure_at:'2027-01-08',return_at:'2027-01-10'},
    {...base,dest:'FCO',departure_at:'2026-12-30',return_at:'2027-01-03'},
  ];
  const holidays=[
    {country:'DE',subdivision_code:'DE-BY',level:'subdivision',date:'2026-12-25'},
    {country:'DE',subdivision_code:'DE-BY',level:'subdivision',date:'2026-12-26'},
    {country:'DE',subdivision_code:'DE-BY',level:'subdivision',date:'2027-01-01'},
    {country:'CH',subdivision_code:'CH-GE',level:'subdivision',date:'2026-12-31'},
  ];
  const out=selectDailyWindowCandidates(rows,{today:'2026-09-22',snapshotAt,holidays,regions:['DE-BY','CH-GE'],
    originRegions:[{airport:'MUC',calendar_subdivision_code:'DE-BY'}]});
  assert.deepEqual([...new Set(out.map(r=>r.departure_at))],['2026-11-27','2026-12-24','2026-12-31','2027-01-08']);
  assert.ok(out.find(r=>r.departure_at==='2026-12-24')?.region_codes.includes('DE-BY'));
  assert.equal(out.some(r=>r.dest==='FCO'),false,'CH-GE-only dates are not admitted for MUC/DE-BY');
});

test('diversity uses a different priced city first and records a last-resort repeat instead of dropping a window',()=>{
  const ordered=[{dest:'BCN',exact_price:90},{dest:'FCO',exact_price:100}];
  assert.deepEqual(chooseCarouselCityForWindow(ordered,new Set(['BCN'])),{candidate:ordered[1],repeat:false,reason:'different_city'});
  assert.deepEqual(chooseCarouselCityForWindow(ordered,new Set(['BCN','FCO'])),{candidate:ordered[0],repeat:true,reason:'last_resort_no_different_eligible_city'});
});
