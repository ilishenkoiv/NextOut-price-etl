import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectDailyWindowCandidates } from './snapshot-daily-window-candidates.mjs';

const snapshotAt='2026-09-22T04:00:00.000Z';
const row=(dest,flight_type,price,over={})=>({origin:'BER',dest,flight_type,departure_at:'2026-10-02',return_at:'2026-10-04',
  price,transfers:flight_type==='direct'?0:1,updated_at:'2026-09-22T03:45:00.000Z',price_source:{table:'window_prices'},...over});

test('daily server set publishes the complete fresh exact union with canonical identity and deterministic per-window order',()=>{
  const rows=[row('BCN','direct',200),row('BCN','any',150),row('FCO','any',100),row('ATH','any',300),
    row('VCE','any',80,{updated_at:'2026-09-19T00:00:00.000Z'})];
  const out=selectDailyWindowCandidates(rows,{today:'2026-09-22',snapshotAt,regions:['DE-BE']});
  assert.deepEqual(out.map(r=>[r.flight_type,r.dest,r.destination_id,r.exact_price,r.position]),[
    ['any','FCO','rome',100,1],['any','BCN','barcelona',150,2],['any','ATH','athens',300,3],['direct','BCN','barcelona',200,1],
  ]);
  assert.ok(out.every(r=>r.window_kind==='weekend'&&r.region_codes.length===0&&r.refresh_status==='fresh'));
});

test('any mode may use the cheaper observed direct row without dropping the independent direct candidate',()=>{
  const out=selectDailyWindowCandidates([row('BCN','direct',90),row('BCN','any',120)],{today:'2026-09-22',snapshotAt,regions:['DE-BE']});
  assert.deepEqual(out.map(r=>[r.flight_type,r.exact_price]),[['any',90],['direct',90]]);
});

test('selection fails closed for unknown place identity, stale rows, non-factual dates and unpublished expansion wave',()=>{
  const rows=[row('ZZZ','any',1),row('MAD','any',100),row('BCN','any',100,{departure_at:'2026-10-03',return_at:'2026-10-05'}),
    row('FCO','any',100,{updated_at:'2026-09-20T00:00:00Z'})];
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

test('window_prices date-window and freshness filtering happens server-side and matches the old client-side result exactly',async()=>{
  const { main } = await import('./snapshot-daily-window-candidates.mjs');
  const instant = Date.parse('2026-09-22T04:00:00.000Z');
  const fresh = '2026-09-22T03:45:00.000Z';
  const allRows = [
    row('BCN','direct',200,{updated_at:fresh}),
    row('BCN','any',150,{updated_at:fresh}),
    row('FCO','any',100,{updated_at:fresh}),
    row('ATH','any',300,{updated_at:fresh}),
    // stale: older than the 36h freshness cutoff (2026-09-20T16:00:00.000Z) -> must be excluded
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
      eq(col,val){data=data.filter(r=>r[col]===val);return builder;},
      order(){return builder;},
      range(from,to){const page=data.slice(from,to+1);if(rows===allRows)returnedRowCount=page.length;return Promise.resolve({data:page,error:null});},
    };
    return builder;
  }
  const db = {
    from(table){
      if(table==='window_prices')return serverTable(allRows);
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
  const expected = selectDailyWindowCandidates(allRows,{today:'2026-09-22',snapshotAt:new Date(instant).toISOString(),holidays:[],regions:['DE-BE'],wave:0});
  assert.deepEqual(published.p_candidates, expected,
    'server-side date/freshness filtering must produce the identical candidate set as the old full-table client-side filter');
});

// ---- Select -> point-refresh -> publish (no freshness wait) ---------------------------

function windowDb(rows){
  function serverTable(data){
    const builder={select(){return builder;},gte(){return builder;},lte(){return builder;},eq(){return builder;},order(){return builder;},
      range:(from,to)=>Promise.resolve({data:data.slice(from,to+1),error:null})};
    return builder;
  }
  let published=null;
  const db={from:(table)=>table==='window_prices'?serverTable(rows):table==='origin_regions'?serverTable([{airport:'BER',calendar_subdivision_code:'DE-BE'}]):serverTable([]),
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
  const handle=windowDb([fresh]);
  let requests=0;
  const confirmedRow={departure_at:'2026-10-02',return_at:'2026-10-04',price:99,transfers:1};
  const provider={request:async function(){ requests++; return {kind:'ok',json:{success:true,data:[confirmedRow]}}; }};
  await main({db:handle.db,instant,force:true,provider,refreshDeadline:Date.now()+120000});
  assert.ok(requests>0,'the provider was called to point-refresh the selected candidate');
  assert.ok(handle.published.p_candidates.some(c=>c.exact_price===99&&c.refresh_status==='fresh'),
    'the confirmed exact price (99) replaces the bulk-selection price (150) before publish');
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
