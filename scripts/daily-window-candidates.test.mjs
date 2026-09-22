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
  assert.match(migration,/refresh_status='unavailable'/);assert.match(migration,/refresh_status='failed'/);
  assert.match(migration,/grant select on public\.daily_window_candidate_epochs,public\.daily_window_candidates to anon,authenticated/);
  assert.match(verify,/same-price refresh did not update observation/);assert.match(verify,/technical failure erased\/freshened saved price/);
  assert.match(verify,/canonical destination identity mapping mismatch/);
  assert.match(verify,/rollback;\s*$/);assert.match(rollback,/rename to daily_window_candidates_rollback_20260922/);
});
