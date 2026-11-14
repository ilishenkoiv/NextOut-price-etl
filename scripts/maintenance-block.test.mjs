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
function makeDb(script, log, onCall = () => {}) {
  const queries = [];
  function chain(table, mode, calls = []) {
    return new Proxy(function () {}, { get: (_t, k) => {
      if (k === 'delete') return () => { log.push('delete:' + table); return chain(table, 'delete', [...calls, { method: 'delete', args: [] }]); };
      if (k === 'then') {
        const key = `${table}:${mode}`; log.push(key); queries.push({ table, mode, calls });
        const p = Promise.resolve().then(() => take(script.from, key)); return p.then.bind(p);
      }
      return (...args) => chain(table, mode, [...calls, { method: String(k), args }]);
    } });
  }
  return {
    from: (t) => chain(t, 'select'),
    rpc: (n) => { log.push('rpc:' + n); onCall('rpc:' + n); const p = Promise.resolve().then(() => take(script.rpc, n)); return { then: p.then.bind(p) }; },
    storage: { from: () => ({
      list: () => { log.push('storage:list'); const p = Promise.resolve().then(() => take(script.storage, 'list')); return { then: p.then.bind(p) }; },
      remove: () => { log.push('storage:remove'); const p = Promise.resolve().then(() => take(script.storage, 'remove')); return { then: p.then.bind(p) }; },
    }) },
    queries,
  };
}

function makeAdapters(script,{onCall=()=>{}}={}) {
  const log = [];
  const db = makeDb(script, log, onCall);
  const store = { args: () => ({ p_owner: 'o', p_token: 1 }), lease: async () => true, runId: 'r' };
  const provider = { request: async () => ({ kind: 'ok', json: { success: true, data: [] } }) };
  let now = AT_0300;
  return { adapters: createAdapters({ db, store, provider, wave: 0, clock: () => now, sleep: async () => {}, random: () => 0 }),
    log, queries: db.queries, setClock: (v) => { now = v; } };
}

const EMPTY_NIGHT_SCRIPT = {
  from: { 'app_errors:select': [EMPTY], 'flight_price_feedback:select': [EMPTY], 'destination_requests:select': [EMPTY],
    'window_prices:select': [EMPTY], 'daily_window_candidate_epochs:select': [EMPTY],
    'window_price_misses:select': [EMPTY], 'price_history:select': [EMPTY] },
  rpc: { collect_storage_metrics: [OK], collection_prune_selected_carousel_revisions: [{ data: 0, error: null }],
    claim_flight_price_audit: [{ data: [], error: null }] },
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
    'collect_storage_metrics', 'plan_bucket_expire', 'window_prices', 'selected_carousel_revision_retention',
    'daily_window_candidates', 'window_price_misses', 'price_history', 'feedback_audit_drain']);
  assert.equal(jobNames.includes('price_storage'), false, 'non-quarterly day: price_storage silently skipped');
  const summaryLines = lines.filter((l) => l.includes('"event":"maintenance_block"'));
  assert.equal(summaryLines.length, 1);
  const parsed = JSON.parse(summaryLines[0]);
  assert.equal(parsed.done, true);
  assert.equal(parsed.jobs.length, 11);
});

test('nightly maintenance records only the retention RPC parent count', async () => {
  const script = { ...EMPTY_NIGHT_SCRIPT,
    rpc: { ...EMPTY_NIGHT_SCRIPT.rpc, collection_prune_selected_carousel_revisions: [{ data: 2, error: null }] } };
  const { adapters, log } = makeAdapters(script);
  let cp = null; let result;
  for (let i = 0; i < 20; i++) {
    result = await adapters.maintenance.step({ job: { id: 1, checkpoint: cp, activeMs: 0 }, deadline: Infinity });
    cp = result.checkpoint;
    if (result.status === 'done') break;
  }
  assert.equal(log.filter((entry) => entry === 'rpc:collection_prune_selected_carousel_revisions').length, 1);
  assert.deepEqual(cp.summary.find((entry) => entry.name === 'selected_carousel_revision_retention'), {
    name: 'selected_carousel_revision_retention', rows: 2, ms: 0,
  });
});

function checkpointAfter(...names) {
  return {
    day: '2026-01-15', checked: Object.fromEntries(names.map((name) => [name, '2026-01-15'])),
    attempted: { collect_storage_metrics: '2026-01-15' }, failed: {}, summary: [], blockDone: false,
  };
}

function assertDeleteFilters(queries, table, filters) {
  const query = queries.find((entry) => entry.table === table && entry.mode === 'delete');
  assert.ok(query, `expected a delete on ${table}`);
  for (const [method, column] of filters) {
    assert.ok(query.calls.some((call) => call.method === method && call.args[0] === column),
      `expected ${table} delete to use ${method}(${column})`);
  }
}

test('daily candidate retention deletes only expired epoch parents and checkpoints the next bounded step', async () => {
  const script = { ...EMPTY_NIGHT_SCRIPT, from: { ...EMPTY_NIGHT_SCRIPT.from,
    'daily_window_candidate_epochs:select': [{ data: [{ snapshot_at: '2025-01-01T00:00:00Z' }], error: null }, EMPTY],
  } };
  const { adapters, log, queries } = makeAdapters(script);
  const before = ['app_errors','flight_price_feedback','destination_requests','collect_storage_metrics',
    'plan_bucket_expire','window_prices','selected_carousel_revision_retention'];
  const first = await adapters.maintenance.step({ job: { id: 1, checkpoint: checkpointAfter(...before), activeMs: 0 }, deadline: Infinity });
  assert.equal(first.status, 'progress');
  assert.equal(first.checkpoint.checked.daily_window_candidates, undefined);
  assert.ok(log.includes('delete:daily_window_candidate_epochs'));
  assert.equal(log.includes('delete:window_prices'), false);
  assertDeleteFilters(queries, 'daily_window_candidate_epochs', [['lt', 'snapshot_at'], ['lte', 'snapshot_at']]);
  const second = await adapters.maintenance.step({ job: { id: 1, checkpoint: first.checkpoint, activeMs: 1000 }, deadline: Infinity });
  assert.equal(second.checkpoint.checked.daily_window_candidates, '2026-01-15');
});

test('miss retention uses checked_at watermark and never touches an active price table', async () => {
  const script = { ...EMPTY_NIGHT_SCRIPT, from: { ...EMPTY_NIGHT_SCRIPT.from,
    'window_price_misses:select': [{ data: [{ checked_at: '2025-01-01T00:00:00Z' }], error: null }, EMPTY],
  } };
  const before = ['app_errors','flight_price_feedback','destination_requests','collect_storage_metrics',
    'plan_bucket_expire','window_prices','selected_carousel_revision_retention','daily_window_candidates'];
  const { adapters, log, queries } = makeAdapters(script);
  const first = await adapters.maintenance.step({ job: { id: 1, checkpoint: checkpointAfter(...before), activeMs: 0 }, deadline: Infinity });
  assert.equal(first.status, 'progress');
  assert.equal(first.checkpoint.checked.window_price_misses, undefined);
  assert.ok(log.includes('delete:window_price_misses'));
  assert.equal(log.includes('delete:window_prices'), false);
  assertDeleteFilters(queries, 'window_price_misses', [['lt', 'checked_at'], ['lte', 'checked_at']]);
  const second = await adapters.maintenance.step({ job: { id: 1, checkpoint: first.checkpoint, activeMs: 1000 }, deadline: Infinity });
  assert.equal(second.checkpoint.checked.window_price_misses, '2026-01-15');
});

test('price history retention deletes only selected expired IDs and checkpoints the next bounded step', async () => {
  const script = { ...EMPTY_NIGHT_SCRIPT, from: { ...EMPTY_NIGHT_SCRIPT.from,
    'price_history:select': [{ data: [{ id: 42 }], error: null }, EMPTY],
  } };
  const before = ['app_errors','flight_price_feedback','destination_requests','collect_storage_metrics',
    'plan_bucket_expire','window_prices','selected_carousel_revision_retention','daily_window_candidates','window_price_misses'];
  const { adapters, log, queries } = makeAdapters(script);
  const first = await adapters.maintenance.step({ job: { id: 1, checkpoint: checkpointAfter(...before), activeMs: 0 }, deadline: Infinity });
  assert.equal(first.status, 'progress');
  assert.equal(first.checkpoint.checked.price_history, undefined);
  assert.ok(log.includes('delete:price_history'));
  assert.equal(log.includes('delete:prices'), false);
  assert.equal(log.includes('delete:offers'), false);
  assertDeleteFilters(queries, 'price_history', [['in', 'id']]);
  const second = await adapters.maintenance.step({ job: { id: 1, checkpoint: first.checkpoint, activeMs: 1000 }, deadline: Infinity });
  assert.equal(second.checkpoint.checked.price_history, '2026-01-15');
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

test('maintenance total_ms includes the final feedback-audit unit before the scheduler persists activeMs',async()=>{
  const checked=Object.fromEntries(['app_errors','flight_price_feedback','destination_requests','collect_storage_metrics','plan_bucket_expire','window_prices','selected_carousel_revision_retention','daily_window_candidates','window_price_misses','price_history','price_storage']
    .map(name=>[name,'2026-01-15']));
  const checkpoint={day:'2026-01-15',checked,attempted:{collect_storage_metrics:'2026-01-15'},failed:{},summary:[],blockDone:false};
  const lines=[];const originalLog=console.log;console.log=line=>lines.push(line);
  let now=AT_0300;
  const db=makeDb(EMPTY_NIGHT_SCRIPT,[],name=>{if(name==='rpc:claim_flight_price_audit')now+=275;});
  const store={args:()=>({p_owner:'o',p_token:1}),lease:async()=>true,runId:'r'};
  const provider={request:async()=>({kind:'ok',json:{success:true,data:[]}})};
  const exact=createAdapters({db,store,provider,clock:()=>now,sleep:async()=>{},random:()=>0});
  try{
    const result=await exact.maintenance.step({job:{id:1,planDate:'2026-01-15',checkpoint,activeMs:7000},deadline:Infinity});
    assert.equal(result.status,'done');
  }finally{console.log=originalLog;}
  const summary=JSON.parse(lines.find(line=>line.includes('maintenance_block')));
  assert.equal(summary.total_ms,7275);
});
