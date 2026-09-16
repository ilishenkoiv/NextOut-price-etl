import test from 'node:test';
import assert from 'node:assert/strict';
import { mainPlan,fastPlan,horizon,catalogue } from './collection-planning.mjs';
import { expansionTargets } from '../src/data/expansion-targets.js';
import { computeAllWindows } from './collection-windows.mjs';
import { publishedSnapshotDestinations } from './snapshot-daily-origin-cheapest.mjs';

test('all 43 targets add 946 real route pairs without duplicate GVA/ZRH collection',()=>{
  const base=mainPlan({date:'2026-09-16',wave:0,prices:[],watches:[]});
  const full=mainPlan({date:'2026-09-16',wave:43,prices:[],watches:[]});
  assert.equal(full.routes.length-base.routes.length,946);assert.equal(full.routes.length,3992);
  assert.equal(catalogue(43).length,182);assert.equal(new Set(full.routes.map(r=>r.key)).size,3992);
  assert.ok(full.routes.every(r=>r.origin!==r.dest));
  assert.ok(expansionTargets(43).every(r=>Number.isFinite(r.lat)&&Number.isFinite(r.lng)));
});
test('warming new airport data cannot publish unknown cities before the app rollout',()=>{
  assert.equal(publishedSnapshotDestinations().has('MAD'),false);
  assert.equal(publishedSnapshotDestinations().has('GVA'),true);
  assert.equal(publishedSnapshotDestinations(10).has('MAD'),true);
});
test('horizon is pinned to the plan month across year-end',()=>{
  assert.deepEqual(horizon('2026-12-31'),['2027-01','2027-02','2027-03','2027-04','2027-05','2027-06']);
});
test('known empty watched route is never removed by weekly rotation',()=>{
  const prices=[{origin:'FRA',dest:'MAD',month:'2026-10',direct:null,any_stops:null}];
  for(let day=10;day<17;day++)assert.ok(mainPlan({date:`2026-09-${day}`,wave:10,prices,watches:[{origin:'FRA',dest:'MAD'}]}).routes.some(r=>r.key==='FRA|MAD'));
});
test('fast plan has a hard bound and fairly interleaves origins',()=>{
  const rows=['FRA','MUC'].flatMap(origin=>Array.from({length:20},(_,i)=>({origin,dest:i%2?'MAD':'BCN',departure_at:`2027-01-${String(i+1).padStart(2,'0')}`,return_at:'2027-02-01',price:100+i,window_kind:'weekend'})));
  const result=fastPlan({rows,watches:[],today:'2026-09-16',wave:10});
  assert.equal(result.tickets.length,40);
  assert.deepEqual(result.tickets.slice(0,4).map(r=>r.origin),['FRA','FRA','MUC','MUC']);
});
test('a country watch keeps a newly added airport in the daily plan',()=>{
  const prices=[{origin:'FRA',dest:'MAD',month:'2026-10',direct:null,any_stops:null}];
  for(let day=10;day<17;day++)assert.ok(mainPlan({date:`2026-09-${day}`,wave:10,prices,
    watches:[{origin:'FRA',watch_scope:'country',country_code:'ES'}]}).routes.some(r=>r.key==='FRA|MAD'));
});
test('shared carousel planner retains exact weekends without corridor expansion',()=>{
  const windows=computeAllWindows([],[],'2026-09-16');
  assert.equal(windows.length,24);
  assert.equal(windows[0].start,'2026-10-02');
  assert.ok(windows.every(w=>w.kind==='weekend'&&w.nights===2));
  assert.equal(new Set(windows.map(w=>w.start+'|'+w.end)).size,windows.length);
});
