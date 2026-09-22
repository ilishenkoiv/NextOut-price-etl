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
test('coordinator wires GUARANTEE_DAILY_MAIN into the collector whenever the script honors it',()=>{
  // Contract test: run-collection.mjs gates the daily-main guarantee on env.GUARANTEE_DAILY_MAIN.
  // If the script keeps that feature but the production workflow stops passing the variable, the
  // guarantee silently never activates. Catch that regression here.
  const script=fs.readFileSync(new URL('run-collection.mjs',import.meta.url),'utf8');
  const workflow=fs.readFileSync(new URL('collection-coordinator.yml',dir),'utf8');
  if(/env\.GUARANTEE_DAILY_MAIN/.test(script)){
    assert.match(workflow,/GUARANTEE_DAILY_MAIN:\s*\$\{\{\s*vars\.GUARANTEE_DAILY_MAIN\s*\|\|\s*'false'\s*\}\}/,
      'run-collection.mjs reads env.GUARANTEE_DAILY_MAIN but collection-coordinator.yml does not pass vars.GUARANTEE_DAILY_MAIN (|| \'false\') into the collector step');
  }
});
