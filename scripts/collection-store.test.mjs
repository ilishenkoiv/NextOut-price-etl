import test from 'node:test';
import assert from 'node:assert/strict';
import { CollectionStore } from './collection-store.mjs';

// Sequential scripted rpc outcomes, one per (re)build of the `db.rpc(...)` call.
function scriptedDb(behaviours) {
  let i = 0; const log = [];
  return { db: { rpc: (name) => { log.push(name); const b = behaviours[Math.min(i, behaviours.length - 1)]; i++;
    return typeof b === 'function' ? b() : Promise.resolve(b); } }, log };
}
const TRANSIENT = { data: null, error: { code: '', message: 'fetch failed' }, status: 503 };
const PERMANENT = { data: null, error: { code: '42501', message: 'permission denied' }, status: 403 };
const OK = { data: true, error: null };

test('idempotent op (collection_state_renew) retries a transient failure with 1s/3s/9s backoff, then succeeds', async () => {
  const { db, log } = scriptedDb([TRANSIENT, TRANSIENT, OK]);
  const waits = [];
  const store = new CollectionStore(db, 'owner-1', '1', { sleep: async (ms) => waits.push(ms), random: () => 0, now: () => 100000 });
  store.token = 1; store.renewedAt = 0;
  const ok = await store.lease();
  assert.equal(ok, true);
  assert.deepEqual(waits, [1000, 3000]);
  assert.equal(log.filter((n) => n === 'collection_state_renew').length, 3); // 2 retries + the successful 3rd call
});

test('idempotent op exhausts its 3-retry budget (1s/3s/9s) and surfaces a structured, named failure', async () => {
  const { db, log } = scriptedDb([TRANSIENT, TRANSIENT, TRANSIENT, TRANSIENT]);
  const waits = []; const lines = []; const original = console.error; console.error = (l) => lines.push(l);
  const store = new CollectionStore(db, 'owner-1', '1', { sleep: async (ms) => waits.push(ms), random: () => 0, now: () => 100000 });
  store.token = 1; store.renewedAt = 0;
  try {
    await assert.rejects(() => store.lease(), /Collection storage operation failed: collection_state_renew \(unknown\)/);
  } finally { console.error = original; }
  assert.deepEqual(waits, [1000, 3000, 9000]);
  assert.equal(log.filter((n) => n === 'collection_state_renew').length, 4); // 1 original + 3 retries, budget exhausted
  const last = JSON.parse(lines.at(-1));
  assert.equal(last.event, 'db_error'); assert.equal(last.op, 'collection_state_renew');
  assert.equal(last.code, 'unknown'); assert.equal(last.attempt, 4);
});

test('permanent error (real Postgres code) is not retried even for an idempotent op', async () => {
  const { db, log } = scriptedDb([PERMANENT]);
  const store = new CollectionStore(db, 'owner-1', '1', { sleep: async () => assert.fail('must not sleep/retry'), random: () => 0 });
  store.token = 1; store.renewedAt = 0;
  await assert.rejects(() => store.lease(), /Collection storage operation failed: collection_state_renew \(42501\)/);
  assert.equal(log.filter((n) => n === 'collection_state_renew').length, 1);
});

test('non-idempotent op (collection_state_claim) is never retried, even on a transient-looking failure', async () => {
  const { db, log } = scriptedDb([TRANSIENT, OK]); // a retry would have "succeeded" on the 2nd — proves it never ran
  const store = new CollectionStore(db, 'owner-1', '1', { sleep: async () => assert.fail('must not sleep/retry'), random: () => 0 });
  await assert.rejects(() => store.claim(), /Collection storage operation failed: collection_state_claim \(unknown\)/);
  assert.equal(log.filter((n) => n === 'collection_state_claim').length, 1);
});
