import test from 'node:test';
import assert from 'node:assert/strict';
import { SequentialSchedule, freshScheduleState } from './collection-schedule.mjs';

async function simulate(mainMinutes){
  const start=Date.parse('2026-09-16T00:07:00Z');let now=start;
  const end=start+86400000;let state=freshScheduleState();let overlaps=0,active=0,restarts=0;
  const handler=minutes=>({maxUnitMs:45000,step:async({job})=>{
    active++;if(active>1)overlaps++;
    const spent=(job.checkpoint?.spent??0)+20000;now+=20000;active--;
    return{status:spent>=minutes*60000?'done':'progress',checkpoint:{spent}};
  }});
  const handlers={main:handler(mainMinutes),tail:handler(408.3),fast:handler(8.5),
    maintenance:{maxUnitMs:45000,step:async()=>{now+=20000;return{status:'progress'};}}};
  while(now<end){
    const run=Math.floor((now-start)/(240*60000));const stopAt=Math.min(end,start+run*240*60000+235*60000);
    const engine=new SequentialSchedule({state:structuredClone(state),clock:()=>now,lease:async()=>true,
      save:async value=>{state=structuredClone(value);},handlers,stopAt});restarts++;
    while(now+45000<stopAt){const before=now;await engine.tick();if(now===before)now+=15000;}
    now=Math.max(now,start+(run+1)*240*60000);
  }
  return{state,overlaps,restarts};
}
test('24-hour scheduling simulation survives six runner handovers without parallel work',async()=>{
  const result=await simulate(331.6);
  assert.equal(result.overlaps,0);assert.equal(result.restarts,6);
  assert.equal(result.state.completedMain,2);
  assert.equal(result.state.missedFast,0);
});
test('an overloaded day keeps the unfinished cursor instead of claiming two complete passes',async()=>{
  const result=await simulate(600);
  assert.ok(result.state.completedMain<2);
  assert.equal(result.overlaps,0);
  assert.ok(result.state.jobs.main.checkpoint.spent>0);
});
