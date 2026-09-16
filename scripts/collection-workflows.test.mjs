import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const dir=new URL('../.github/workflows/',import.meta.url);
test('every data workflow shares the same non-canceling queued lock',()=>{
  for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.yml'))){
    const text=fs.readFileSync(new URL(file,dir),'utf8');
    assert.match(text,/concurrency:\s*\n\s+group: nextout-data-collection\s*\n\s+queue: max\s*\n\s+cancel-in-progress: false/,file);
  }
});
test('every old main/window/audit/snapshot job is disabled in coordinated mode',()=>{
  for(const file of ['fetch-prices.yml','fetch-window-prices.yml','check-flight-price-feedback.yml','snapshot-daily-origin-cheapest.yml']){
    const text=fs.readFileSync(new URL(file,dir),'utf8').split('\njobs:\n')[1];
    const jobs=[...text.matchAll(/^  [\w-]+:\r?$/gm)].length;
    const gates=[...text.matchAll(/vars\.COLLECTION_MODE != 'coordinated'/g)].length;
    assert.equal(gates,jobs,file);
  }
});
test('new worker remains opt-in and leaves time to save before the Actions timeout',()=>{
  const text=fs.readFileSync(new URL('collection-coordinator.yml',dir),'utf8');
  assert.match(text,/if: vars.COLLECTION_MODE == 'coordinated'/);
  assert.match(text,/COLLECTION_SESSION_MINUTES: '235'/);
  assert.match(text,/timeout-minutes: 250/);
  assert.match(text,/EXPANSION_WAVE:.*\|\| '0'/);
});
