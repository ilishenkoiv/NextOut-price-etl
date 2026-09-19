import { test } from 'node:test';
import assert from 'node:assert/strict';
import { publishEndOfSessionPool, shouldPublishEndOfSession } from './run-collection.mjs';

// A minimal stand-in for the leased Supabase client used only by the readback:
//   db.from('daily_origin_cheapest_pool').select('snapshot_at').eq('snapshot_at', x).limit(1)
// `pool` is the shared array a fake publisher writes into, so the readback observes
// exactly what publication produced — the same independent-readback contract as prod.
function makeDb(pool, { readError = null } = {}) {
  return {
    from(table) {
      assert.equal(table, 'daily_origin_cheapest_pool');
      let wanted;
      const builder = {
        select(cols) { assert.equal(cols, 'snapshot_at'); return builder; },
        eq(col, val) { assert.equal(col, 'snapshot_at'); wanted = val; return builder; },
        limit(n) {
          if (readError) return Promise.resolve({ data: null, error: readError });
          return Promise.resolve({ data: pool.filter(r => r.snapshot_at === wanted).slice(0, n), error: null });
        },
      };
      return builder;
    },
  };
}

// A fake publisher that writes a complete snapshot row set for the requested timestamp,
// mirroring snapshot-daily-origin-cheapest which guarantees pool ⊆ offers.
function writingPublisher(pool, calls) {
  return async ({ db, snapshotAt, expansionWave }) => {
    calls.push({ snapshotAt, expansionWave, hadDb: Boolean(db) });
    pool.push({ snapshot_at: snapshotAt, origin: 'BER' });
  };
}

const fixedClock = () => Date.parse('2026-09-19T18:00:00.000Z');

test('partial main: unfinished pass triggers a fenced, read-back republish', async () => {
  const pool = [];
  const calls = [];
  const leaseCalls = [];
  const result = await publishEndOfSessionPool({
    db: makeDb(pool),
    lease: async () => { leaseCalls.push(1); return true; },
    snapshotWave: 0,
    clock: fixedClock,
    publish: writingPublisher(pool, calls),
  });
  assert.deepEqual(result, { published: true, snapshotAt: '2026-09-19T18:00:00.000Z' });
  assert.equal(calls.length, 1, 'publisher invoked exactly once');
  assert.equal(calls[0].snapshotAt, '2026-09-19T18:00:00.000Z');
  assert.equal(calls[0].expansionWave, 0);
  assert.ok(calls[0].hadDb, 'publisher receives the leased db');
  assert.ok(leaseCalls.length >= 2, 'lease is checked before and after publish');
  assert.equal(pool.length, 1, 'a fresh snapshot row set exists');
});

test('resumed main: mid-cursor pass still publishes and reads back the NEW snapshot_at', async () => {
  // Pre-seed an older frozen snapshot; the readback must key on the newly written
  // timestamp, not merely find "some" pool rows.
  const pool = [{ snapshot_at: '2026-09-18T04:48:33.689+00:00', origin: 'BER' }];
  const calls = [];
  const result = await publishEndOfSessionPool({
    db: makeDb(pool),
    lease: async () => true,
    snapshotWave: 3,
    clock: fixedClock,
    publish: writingPublisher(pool, calls),
  });
  assert.equal(result.snapshotAt, '2026-09-19T18:00:00.000Z');
  assert.equal(calls[0].expansionWave, 3, 'snapshot wave is threaded through');
  assert.ok(pool.some(r => r.snapshot_at === result.snapshotAt), 'new snapshot present');
});

test('completed main: a pass that already published this session is not republished', async () => {
  // Decision gate (as wired in main()): completedMain advanced -> skip.
  assert.equal(shouldPublishEndOfSession(5, 6), false);
  // Partial/resumed -> publish.
  assert.equal(shouldPublishEndOfSession(5, 5), true);

  // And when the gate is false, the publish path is never entered / db never touched.
  const calls = [];
  let published = false;
  const completedMainBefore = 5;
  const completedMainAfter = 6; // main reached done during the session
  if (shouldPublishEndOfSession(completedMainBefore, completedMainAfter)) {
    published = true;
    await publishEndOfSessionPool({
      db: makeDb([]), lease: async () => true, clock: fixedClock,
      publish: writingPublisher([], calls),
    });
  }
  assert.equal(published, false, 'no second publish after a completed main pass');
  assert.equal(calls.length, 0);
});

test('publication failure: readback finds no rows -> throws, no false success', async () => {
  const pool = [];
  const calls = [];
  // Publisher that silently writes nothing (e.g. an aborted/empty publish).
  const nonWritingPublisher = async ({ snapshotAt, expansionWave }) => { calls.push({ snapshotAt, expansionWave }); };
  await assert.rejects(
    () => publishEndOfSessionPool({
      db: makeDb(pool), lease: async () => true, clock: fixedClock, publish: nonWritingPublisher,
    }),
    /publish was not confirmed by readback/,
  );
  assert.equal(calls.length, 1, 'publish was attempted');
});

test('publication failure: a readback transport error is surfaced, not swallowed', async () => {
  await assert.rejects(
    () => publishEndOfSessionPool({
      db: makeDb([], { readError: { message: 'connection reset' } }),
      lease: async () => true, clock: fixedClock, publish: async () => {},
    }),
    /pool readback failed: connection reset/,
  );
});

test('lease loss before publish: throws and never calls the publisher', async () => {
  const calls = [];
  await assert.rejects(
    () => publishEndOfSessionPool({
      db: makeDb([]), lease: async () => false, clock: fixedClock,
      publish: writingPublisher([], calls),
    }),
    /forbidden: lease lost$/,
  );
  assert.equal(calls.length, 0, 'no publish attempted without the lease');
});

test('lease loss after publish: publication is not reported as confirmed', async () => {
  const pool = [];
  const calls = [];
  let n = 0;
  await assert.rejects(
    () => publishEndOfSessionPool({
      db: makeDb(pool),
      lease: async () => (++n === 1), // held before publish, lost immediately after
      clock: fixedClock,
      publish: writingPublisher(pool, calls),
    }),
    /lease lost after publish/,
  );
  assert.equal(calls.length, 1, 'publish ran while the lease was held');
});
