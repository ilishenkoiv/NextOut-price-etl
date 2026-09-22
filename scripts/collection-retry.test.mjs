import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from './collection-adapters.mjs';

// Sequential scripted DB outcomes. Each resolution shifts the next behaviour; the last
// behaviour repeats. A behaviour is a plain {data,error,status} result, or a function
// (which may throw to simulate a transport-level fetch rejection).
function scripted(behaviours) {
  let i = 0;
  return () => {
    const b = behaviours[Math.min(i, behaviours.length - 1)]; i++;
    if (typeof b === 'function') return b();
    return b;
  };
}
// A fresh PostgREST-like thenable builder per attempt; any chained method returns a new
// builder, and awaiting it resolves via next(). db.from/db.rpc log every (re)build.
function makeDb(next, log) {
  const builder = () => new Proxy(function () {}, { get: (_t, k) => {
    if (k === 'then') { const p = Promise.resolve().then(next); return p.then.bind(p); }
    return () => builder();
  }});
  const thenable = () => Promise.resolve().then(next);
  return {
    from: t => { log.push('from:' + t); return builder(); },
    rpc: n => { log.push('rpc:' + n); return thenable(); },
    storage: { from: () => ({ upload: () => { log.push('upload'); return thenable(); },
      list: () => { log.push('list'); return thenable(); },
      remove: () => { log.push('remove'); return thenable(); },
      download: () => thenable() }) },
  };
}
const TRANSIENT = { status: 503, error: { code: '', message: 'fetch failed' } };
const OK_EMPTY = { data: [], error: null };
const okAck = { data: true, error: null };

function adaptersWith({ behaviours, log = [], lease = async () => true, clock = () => 100000, plan = (_k, build) => build() }) {
  const db = makeDb(scripted(behaviours), log);
  const store = { args: () => ({ p_owner: 'o', p_token: 1 }), lease, plan, runId: 'r' };
  const provider = { request: async () => ({ kind: 'ok', json: { success: true, data: {} } }) };
  return { adapters: createAdapters({ db, store, provider, wave: 0, clock, sleep: async () => {}, random: () => 0 }), log };
}
const job = { id: 1, planDate: '2026-09-16', startedAt: 100000, checkpoint: null };
const countFrom = (log, t) => log.filter(x => x === 'from:' + t).length;
const countRpc = (log, n) => log.filter(x => x === 'rpc:' + n).length;

test('transient read fails once then succeeds (builder rebuilt per attempt)', async () => {
  const { adapters, log } = adaptersWith({ behaviours: [TRANSIENT, OK_EMPTY] });
  const result = await adapters.fast.step({ job, deadline: 200000 });
  assert.equal(result.status, 'done');           // empty plan → nothing to commit
  assert.equal(countFrom(log, 'window_prices'), 2); // one retry ⇒ two fresh builders
});

test('transport exception fails once then succeeds', async () => {
  const boom = () => { throw new TypeError('fetch failed'); };
  const { adapters, log } = adaptersWith({ behaviours: [boom, OK_EMPTY] });
  const result = await adapters.fast.step({ job, deadline: 200000 });
  assert.equal(result.status, 'done');
  assert.equal(countFrom(log, 'window_prices'), 2);
});

test('HTTP 5xx is retried', async () => {
  const { adapters, log } = adaptersWith({ behaviours: [{ status: 504, error: { message: 'Gateway Timeout' } }, OK_EMPTY] });
  await adapters.fast.step({ job, deadline: 200000 });
  assert.equal(countFrom(log, 'window_prices'), 2);
});

test('permanent Postgres/RLS error is not retried and surfaces honestly', async () => {
  const { adapters, log } = adaptersWith({ behaviours: [{ status: 403, error: { code: '42501', message: 'permission denied' } }] });
  await assert.rejects(() => adapters.fast.step({ job, deadline: 200000 }), /Collection database operation failed \(42501\)/);
  assert.equal(countFrom(log, 'window_prices'), 1); // single attempt, no retry storm
});

test('exhausted transient retries return a failure', async () => {
  const { adapters, log } = adaptersWith({ behaviours: [TRANSIENT] }); // always transient
  await assert.rejects(() => adapters.fast.step({ job, deadline: 200000 }), /Collection database operation failed/);
  // fast unit deadline = clock()+30s ⇒ backoff budget fits 1 + 2 bounded retries = 3 fresh builders.
  assert.equal(countFrom(log, 'window_prices'), 3);
});

test('deadline with no room forbids a late retry attempt', async () => {
  // clock+9000 < deadline (no entry yield) but no budget for backoff+request ⇒ delays=[]
  const { adapters, log } = adaptersWith({ behaviours: [TRANSIENT], clock: () => 200000 });
  await assert.rejects(() => adapters.fast.step({ job, deadline: 210000 }), /Collection database operation failed/);
  assert.equal(countFrom(log, 'window_prices'), 1);
});

test('lease lost between attempts aborts immediately', async () => {
  let n = 0; const lease = async () => (++n < 2); // true, then false
  const { adapters, log } = adaptersWith({ behaviours: [TRANSIENT], lease });
  await assert.rejects(() => adapters.fast.step({ job, deadline: 200000 }), /lease lost/);
  assert.equal(countFrom(log, 'window_prices'), 1); // second attempt never built
});

test('cursor does not advance when the commit is not confirmed', async () => {
  // plan mock short-circuits reads ⇒ the only DB op is the commit RPC, which fails permanently.
  const plan = () => ({ tickets: [{ origin: 'FRA', dest: 'MAD', flight_type: 'direct', departure_at: '2027-01-10', return_at: '2027-01-17', nights: 7, window_kind: 'weekend' }] });
  const { adapters } = adaptersWith({ behaviours: [OK_EMPTY,{ status: 403, error: { code: '42501', message: 'denied' } }], plan });
  await assert.rejects(() => adapters.fast.step({ job, deadline: 200000 }), /42501/); // throws before cursor++
});

test('idempotent commit retries transient then acknowledges once, advancing the cursor by one', async () => {
  const plan = () => ({ tickets: [{ origin: 'FRA', dest: 'MAD', flight_type: 'direct', departure_at: '2027-01-10', return_at: '2027-01-17', nights: 7, window_kind: 'weekend' }] });
  const { adapters, log } = adaptersWith({ behaviours: [OK_EMPTY,TRANSIENT,okAck,okAck], plan });
  const result = await adapters.fast.step({ job, deadline: 200000 });
  assert.equal(result.checkpoint.cursor, 1);
  assert.equal(countRpc(log, 'collection_commit_window'), 2); // retried, single acknowledged success
});

test('non-idempotent claim_flight_price_audit is never retried', async () => {
  const { adapters, log } = adaptersWith({ behaviours: [TRANSIENT] });
  await assert.rejects(() => adapters.priority.step({ job: { ...job, checkpoint: { cycle:job.id,dueAt:0,phase:'audit',auditDone:false,
    roulette:{cycle:job.id,cursor:0,done:false,errors:0} } }, deadline: 200000 }),
    /Collection database operation failed/);
  assert.equal(countRpc(log, 'claim_flight_price_audit'), 1); // single attempt, no retry
});
