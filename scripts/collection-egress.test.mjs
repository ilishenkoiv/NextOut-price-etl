import test from 'node:test';
import assert from 'node:assert/strict';
import { recordRead, egressSummary, resetEgress } from './collection-egress.mjs';

test('egress tracker accumulates rows and approximate bytes per table across multiple reads',()=>{
  resetEgress();
  recordRead('offers',[{a:1},{a:2}]);
  recordRead('offers',[{a:3}]);
  recordRead('window_prices',[{b:1}]);
  const summary=egressSummary();
  assert.equal(summary.event,'egress_summary');
  assert.equal(summary.tables.offers.rows,3);
  assert.equal(summary.tables.window_prices.rows,1);
  assert.ok(summary.tables.offers.bytes>0);
  assert.equal(summary.totalRows,4);
  assert.equal(summary.totalBytes,summary.tables.offers.bytes+summary.tables.window_prices.bytes);
});

test('an empty or missing page still registers the table with zero rows, and resetEgress clears all tables',()=>{
  resetEgress();
  recordRead('offers',[]);
  recordRead('offers',undefined);
  assert.equal(egressSummary().tables.offers.rows,0);
  assert.equal(egressSummary().tables.offers.bytes,0);
  resetEgress();
  assert.deepEqual(egressSummary().tables,{});
  assert.equal(egressSummary().totalRows,0);
});
