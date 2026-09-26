import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdapters } from './collection-adapters.mjs';

// Berlin local time helper (CET, UTC+1) for a fixed, DST-uninvolved test day.
const berlinOn = (dateIso, h, m) => Date.parse(`${dateIso}T${String(h - 1).padStart(2, '0')}:${String(m).padStart(2, '0')}:00Z`);
const berlin = (h, m) => berlinOn('2026-01-15', h, m);
const AT_0300 = berlin(3, 0);
const AT_1000 = berlin(10, 0);
const EMPTY = { data: [], error: null };
const OK = { data: true, error: null };

function take(map, key) {
  const arr = map?.[key];
  if (!arr || !arr.length) return EMPTY;
  return arr.length > 1 ? arr.shift() : arr[0];
}

// A minimal PostgREST-like chainable builder. Tracks whether .delete() was called on this chain
// so select vs delete responses can be scripted independently per table.
function makeDb(script, log) {
  function chain(table, mode) {
    return new Proxy(function () {}, { get: (_t, k) => {
      if (k === 'delete') return () => { log.push('delete:' + table); return chain(table, 'delete'); };
      if (k === 'then') {
        const key = `${table}:${mode}`; log.push(key);
        const p = Promise.resolve().then(() => take(script.from, key)); return p.then.bind(p);
      }
      return () => chain(table, mode);
    } });
  }
  return {
    from: (t) => chain(t, 'select'),
    rpc: (n) => { log.push('rpc:' + n); const p = Promise.resolve().then(() => take(script.rpc, n)); return { then: p.then.bind(p) }; },
    storage: { from: () => ({
      list: () => { log.push('storage:list'); const p = Promise.resolve().then(() => take(script.storage, 'list')); return { then: p.then.bind(p) }; },
      remove: () => { log.push('storage:remove'); const p = Promise.resolve().then(() => take(script.storage, 'remove')); return { then: p.then.bind(p) }; },
    }) },
  };
}

function makeAdapters(script) {
  const log = [];
  const db = makeDb(script, log);
  const store = { args: () => ({ p_owner: 'o', p_token: 1 }), lease: async () => true, runId: 'r' };
  const provider = { request: async () => ({ kind: 'ok', json: { success: true, data: [] } }) };
  let now = AT_0300;
  return { adapters: createAdapters({ db, store, provider, wave: 0, clock: () => now, sleep: async () => {}, random: () => 0 }),
    log, setClock: (v) => { now = v; } };
}

const EMPTY_NIGHT_SCRIPT = {
  from: { 'app_errors:select': [EMPTY], 'flight_price_feedback:select': [EMPTY], 'destination_requests:select': [EMPTY],
    'window_prices:select': [EMPTY] },
  rpc: { collect_storage_metrics: [OK], claim_flight_price_audit: [{ data: [], error: null }] },
  storage: { list: [{ data: [], error: null }] },
};

test('outside 03:00-05:45 Berlin: no-op, zero DB calls', async () => {
  const { adapters, log, setClock } = makeAdapters(EMPTY_NIGHT_SCRIPT);
  setClock(AT_1000);
  const result = await adapters.maintenance.step({ job: { id: 1, checkpoint: null, activeMs: 0 }, deadline: Infinity });
  assert.equal(result.status, 'empty');
  assert.deepEqual(log, []);
});

test('a due, all-empty night runs every job (2026-01-15, non-quarterly) and settles with one summary log', async () => {
  const { adapters, log } = makeAdapters(EMPTY_NIGHT_SCRIPT);
  let cp = null, result;
  const lines = []; const originalLog = console.log; console.log = (l) => lines.push(l);
  try {
    for (let i = 0; i < 20; i++) {
      result = await adapters.maintenance.step({ job: { id: 1, planDate: '2026-01-15', checkpoint: cp, activeMs: i * 1000 }, deadline: Infinity });
      cp = result.checkpoint;
      if (result.status === 'done') break;
    }
  } finally { console.log = originalLog; }
  assert.equal(result.status, 'done');
  const jobNames = cp.summary.map((j) => j.name);
  assert.deepEqual(jobNames, ['app_errors', 'flight_price_feedback', 'destination_requests',
    'collect_storage_metrics', 'plan_bucket_expire', 'window_prices', 'feedback_audit_drain']);
  assert.equal(jobNames.includes('price_storage'), false, 'non-quarterly day: price_storage silently skipped');
  const summaryLines = lines.filter((l) => l.includes('"event":"maintenance_block"'));
  assert.equal(summaryLines.length, 1);
  const parsed = JSON.parse(summaryLines[0]);
  assert.equal(parsed.done, true);
  assert.equal(parsed.jobs.length, 7);
});

test('resume across calls, same night: an unfinished job (rows found) is retried, not marked checked, until it drains', async () => {
  const script = { ...EMPTY_NIGHT_SCRIPT,
    from: { ...EMPTY_NIGHT_SCRIPT.from,
      'app_errors:select': [{ data: [{ id: 1 }], error: null }, EMPTY], // one page of work, then empty
    } };
  const { adapters, log } = makeAdapters(script);
  const r1 = await adapters.maintenance.step({ job: { id: 1, checkpoint: null, activeMs: 0 }, deadline: Infinity });
  assert.equal(r1.status, 'progress');
  assert.equal(r1.checkpoint.checked.app_errors, undefined, 'not yet marked done — a delete just happened');
  assert.ok(log.includes('delete:app_errors'));
  const r2 = await adapters.maintenance.step({ job: { id: 1, checkpoint: r1.checkpoint, activeMs: 1000 }, deadline: Infinity });
  assert.equal(r2.checkpoint.checked.app_errors, '2026-01-15', 'now marked checked for today, second call found nothing');
});

test('once per Berlin day: fully blockDone stays a no-op for the rest of that night', async () => {
  const { adapters, log } = makeAdapters(EMPTY_NIGHT_SCRIPT);
  let cp = null, result;
  for (let i = 0; i < 20; i++) {
    result = await adapters.maintenance.step({ job: { id: 1, checkpoint: cp, activeMs: 0 }, deadline: Infinity });
    cp = result.checkpoint;
    if (result.status === 'done') break;
  }
  assert.equal(cp.blockDone, true);
  const before = log.length;
  const again = await adapters.maintenance.step({ job: { id: 1, checkpoint: cp, activeMs: 0 }, deadline: Infinity });
  assert.equal(again.status, 'empty');
  assert.equal(log.length, before, 'no further DB calls once blockDone for today');
});

test('15-minute budget cap stops the block for tonight even mid-work, and logs done:false', async () => {
  const script = { ...EMPTY_NIGHT_SCRIPT,
    from: { ...EMPTY_NIGHT_SCRIPT.from, 'app_errors:select': [{ data: [{ id: 1 }], error: null }] } }; // always finds work
  const { adapters } = makeAdapters(script);
  const lines = []; const originalLog = console.log; console.log = (l) => lines.push(l);
  let result;
  try {
    result = await adapters.maintenance.step({ job: { id: 1, checkpoint: null, activeMs: 15 * 60_000 }, deadline: Infinity });
  } finally { console.log = originalLog; }
  assert.equal(result.status, 'done');
  assert.equal(result.checkpoint.blockDone, true);
  const summary = JSON.parse(lines.find((l) => l.includes('maintenance_block')));
  assert.equal(summary.done, false);
});

test('price_storage runs (and only runs) on the first day of a quarter', async () => {
  const scriptQuarter = { ...EMPTY_NIGHT_SCRIPT,
    from: { ...EMPTY_NIGHT_SCRIPT.from, 'window_price_progress:select': [EMPTY] } };
  const { adapters, setClock } = makeAdapters(scriptQuarter);
  setClock(berlinOn('2026-01-01', 3, 0));
  let cp = null, result;
  for (let i = 0; i < 20; i++) {
    result = await adapters.maintenance.step({ job: { id: 1, checkpoint: cp, activeMs: 0 }, deadline: Infinity });
    cp = result.checkpoint;
    if (result.status === 'done') break;
  }
  assert.ok(cp.summary.some((j) => j.name === 'price_storage'), 'price_storage ran on 2026-01-01 (quarter start)');
});
