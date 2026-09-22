// Stage 2 contract: one selection-owner, one refresh-owner.
//
// snapshot-daily-origin-cheapest.mjs is the SOLE author of roulette pool membership,
// order and rank, and it selects at most once per observed day. Every other place that
// used to (re)publish the pool — the coordinator's end-of-session hook and its main-pass
// completion stage — must delegate to that owner and must NOT rebuild or re-rank the pool
// once the day's selection exists. The price-refresh owner (coordinator maintenance) only
// revalidates already-selected tickets: it updates fare/timestamp/provenance on `offers`
// and never touches the pool tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The selection owner reads its service key at import time, so set it before importing.
process.env.SUPABASE_SERVICE_KEY ??= 'test-service-key';
const { main: publishSnapshot } = await import('./snapshot-daily-origin-cheapest.mjs');
const { createAdapters } = await import('./collection-adapters.mjs');

// A thenable that resolves a PostgREST-shaped { data, error } result.
const settle = (result) => ({ then: (onFulfilled, onRejected) => Promise.resolve(result).then(onFulfilled, onRejected) });

// Minimal Supabase double for snapshot-daily-origin-cheapest.main(). Records every write
// so a test can assert selection left membership/order untouched (zero writes) when guarded.
function selectionDb({ published = true, publishError = null, offers = [] } = {}) {
  const writes = [];
  const reads = [];
  const from = (table) => {
    const ctx = { table, cols: null, filters: {} };
    const chain = {
      select(cols) { ctx.cols = cols; return chain; },
      eq(col, val) { ctx.filters[col] = val; return chain; },
      gte() { return chain; },
      gt() { return chain; },
      order() { return chain; },
      limit(n) {
        reads.push({ table, cols: ctx.cols, filters: { ...ctx.filters } });
        return settle({ data: [], error: null });
      },
      range() { reads.push({ table, op: 'range' }); return settle({ data: table === 'offers' ? offers : [], error: null }); },
      upsert(rows, opts) { writes.push({ op: 'upsert', table, count: rows.length, opts }); return settle({ error: null }); },
      insert(rows) { writes.push({ op: 'insert', table, count: rows.length }); return settle({ error: null }); },
      delete() { writes.push({ op: 'delete', table }); return chain; },
      lt() { return settle({ error: null }); },
    };
    return chain;
  };
  const rpc=(name,args)=>{reads.push({op:'rpc',name});if(publishError)return settle({data:null,error:publishError});
    writes.push({op:'rpc',name,args});return settle({data:published,error:null});};
  return { from, rpc, writes, reads };
}

const freshOffer = {
  origin: 'BER', market: 'de', dest: 'BCN', flight_type: 'any', price: 120,
  departure_at: '2027-01-10', return_at: '2027-01-17', transfers: 1,
  updated_at: '2027-01-05T06:00:00.000Z', price_source: null,
};

test('selection owner rebuilds the pool when today has no snapshot yet', async () => {
  const db = selectionDb({ offers: [freshOffer] });
  const result = await publishSnapshot({ db, snapshotAt: '2027-01-05T12:00:00.000Z', expansionWave: 0 });
  assert.deepEqual(result, { rebuilt: true, observedOn: '2027-01-05', snapshotAt: '2027-01-05T12:00:00.000Z' });
  assert.equal(db.writes.length,1);assert.equal(db.writes[0].name,'publish_daily_cheapest_selection');
  assert.equal(db.writes[0].args.p_pool.length,1);assert.equal(db.writes[0].args.p_rank1.length,1);
  assert.equal(db.writes[0].args.p_pool[0].destination_id,'barcelona');
  assert.equal(db.writes[0].args.p_rank1[0].destination_id,'barcelona');
});

test('selection owner runs at most once per day: a second same-day trigger writes nothing', async () => {
  const db = selectionDb({ published:false,offers: [freshOffer] });
  const result = await publishSnapshot({ db, snapshotAt: '2027-01-05T22:00:00.000Z', expansionWave: 0 });
  assert.deepEqual(result, { rebuilt: false, observedOn: '2027-01-05', snapshotAt: null,reason:'already_published' });
  assert.equal(db.writes.length,1,'one atomic guarded RPC attempt; no direct table writes');
});

test('force overrides the once-per-day guard for an explicit owner rebuild', async () => {
  const db = selectionDb({ offers: [freshOffer] });
  const result = await publishSnapshot({ db, snapshotAt: '2027-01-05T23:00:00.000Z', expansionWave: 0, force: true });
  assert.equal(result.rebuilt, true, 'force rebuilds even when a same-day pool exists');
  assert.equal(db.writes[0].args.p_force,true);
});

test('a missed nightly selection is safely applied exactly once by a later same-day catch-up', async () => {
  // Night missed → today's pool is still absent when the catch-up (post-coordinator) trigger
  // fires later the same day: it performs the selection.
  const first = selectionDb({ offers: [freshOffer] });
  const r1 = await publishSnapshot({ db: first, snapshotAt: '2027-01-05T14:00:00.000Z', expansionWave: 0 });
  assert.equal(r1.rebuilt, true, 'the missed night is caught up');
  assert.equal(first.writes.length,1,'the pool is built once through the atomic RPC');
  // Any further same-day catch-up is a guarded no-op — the day still gets exactly one selection.
  const second = selectionDb({ published:false,offers: [freshOffer] });
  const r2 = await publishSnapshot({ db: second, snapshotAt: '2027-01-05T15:00:00.000Z', expansionWave: 0 });
  assert.equal(r2.rebuilt, false, 'no second selection the same day');
  assert.equal(second.writes.length,1);
});

test('two concurrent selections cannot write different pools (guard serializes them)', async () => {
  // Model two selection attempts against one shared pool table. The first writes today's pool;
  // the second sees observed_on already present and writes nothing. Combined with the shared
  // concurrency lock (one selection at a time) this makes divergent pools impossible.
  const first = selectionDb({ offers: [freshOffer] });
  const r1 = await publishSnapshot({ db: first, snapshotAt: '2027-01-05T03:30:00.000Z', expansionWave: 0 });
  // Record that today's pool now exists (what a real second reader would observe).
  const second = selectionDb({ published:false,offers: [freshOffer] });
  const r2 = await publishSnapshot({ db: second, snapshotAt: '2027-01-05T03:30:05.000Z', expansionWave: 0 });
  assert.equal(r1.rebuilt, true, 'the first selection builds the day\'s pool');
  assert.equal(r2.rebuilt, false, 'the second selection is a guarded no-op');
  assert.equal(second.writes.length,1,'the second attempt reaches only the atomic guard — no divergent epoch');
});

test('00:xx/02:xx Berlin workflow completions are pre-due no-ops and do not block the 03:30 selection',async()=>{
  for(const stamp of ['2027-01-05T00:15:00+01:00','2027-01-05T02:59:00+01:00']){
    const db=selectionDb({offers:[freshOffer]});const r=await publishSnapshot({db,snapshotAt:stamp,expansionWave:0});
    assert.equal(r.reason,'not_due');assert.equal(db.reads.length,0);assert.equal(db.writes.length,0);
  }
  const due=selectionDb({offers:[freshOffer]});assert.equal((await publishSnapshot({db:due,snapshotAt:'2027-01-05T03:30:00+01:00'})).rebuilt,true);
});

test('atomic publication failure leaves no completion write and a later catch-up can retry',async()=>{
  const failed=selectionDb({offers:[freshOffer],publishError:{code:'XX001',message:'rolled back'}});
  await assert.rejects(()=>publishSnapshot({db:failed,snapshotAt:'2027-01-05T04:00:00+01:00'}),error=>error?.message==='rolled back');
  assert.equal(failed.writes.length,0);
  const retry=selectionDb({offers:[freshOffer]});assert.equal((await publishSnapshot({db:retry,snapshotAt:'2027-01-05T05:00:00+01:00'})).rebuilt,true);
});

// ---- Coordinator priority refresh (the coordinated-mode owner) ----

// Recording double for the maintenance adapter: rpc() and a chainable from() that flags
// any pool-table write. store.plan short-circuits to the supplied tickets.
function maintenanceHarness(tickets, response, { lease = async () => true, replacements = {}, allowedDests = ['BCN','ATH','FCO'] } = {}) {
  const calls = [];
  const poolWrites = [];
  const db = {
    rpc: (name, args) => { calls.push({ name, args }); return settle({ data: true, error: null }); },
    from(table) {
      const chain = new Proxy({}, { get: (_, key) => {
        if (key === 'then') { const p = Promise.resolve({ data: [], error: null }); return p.then.bind(p); }
        if (['insert', 'upsert', 'update', 'delete'].includes(key) && table === 'daily_origin_cheapest_pool') {
          return (...a) => { poolWrites.push({ key, a }); return chain; };
        }
        return () => chain;
      } });
      return chain;
    },
    storage: { from: () => ({ list: async () => ({ data: [], error: null }), remove: async () => ({ data: {}, error: null }) }) },
  };
  const store = { args: () => ({ p_owner: 'o', p_token: 1 }), lease, plan: async () => ({ tickets,replacements,allowedDests }), runId: '1' };
  let requests = 0;
  const provider = { request: async url => { requests += 1; return response(requests,url); } };
  const adapters = createAdapters({ db, store, provider, clock: () => 1_700_000_000_000, wave: 0 });
  return { adapters, calls, poolWrites, get requests() { return requests; } };
}

const rouletteTicket = (dest, rank) => ({ origin: 'BER', dest, flight_type: 'any', departure_at: '2027-01-10', return_at: '2027-01-17', rank });
const foundResponse = (_n,url) => {const destination=new URL(url).searchParams.get('destination');return { kind: 'ok', json: { success: true, data: [{ origin: 'BER', destination, departure_at: '2027-01-10T06:00:00Z', return_at: '2027-01-17T20:00:00Z', price: 111, transfers: 1, currency: 'EUR' }] } };};
const priorityCp = (cursor=0) => ({cycle:1,dueAt:0,phase:'roulette',auditDone:true,roulette:{cycle:1,cursor,done:false,errors:0}});

test('refresh owner updates only fare/timestamp/provenance and never writes the pool', async () => {
  const h = maintenanceHarness([rouletteTicket('BCN', 1)], foundResponse);
  const result = await h.adapters.priority.step({ job: { id: 1, planDate: '2027-01-05', checkpoint: priorityCp() }, deadline: 1_700_000_200_000 });
  assert.deepEqual(h.calls.map(c=>c.name),['collection_commit_roulette','collection_revive_route']);
  const patch = h.calls[0].args.p_result;
  assert.equal(patch.status, 'found');
  assert.equal(patch.price, 111, 'fare updated');
  assert.ok(patch.updated_at, 'timestamp updated');
  assert.ok('price_source' in patch, 'provenance attached');
  assert.equal(h.poolWrites.length, 0, 'membership/rank/order untouched');
  assert.equal(result.checkpoint.roulette.cursor, 1);
});

test('confirmed unavailable target becomes explicitly exhausted only after replacement candidates are exhausted', async () => {
  const emptyResponse = () => ({ kind: 'ok', json: { success: true, data: [] } });
  const h = maintenanceHarness([rouletteTicket('BCN', 1)], emptyResponse);
  const first=await h.adapters.priority.step({ job: { id: 1, planDate: '2027-01-05', checkpoint: priorityCp() }, deadline: 1_700_000_200_000 });
  assert.equal(h.calls.length,0);assert.equal(first.checkpoint.roulette.pendingReplacement.ticket.dest,'BCN');
  await h.adapters.priority.step({ job: { id: 1, planDate: '2027-01-05', checkpoint: first.checkpoint }, deadline: 1_700_000_200_000 });
  assert.equal(h.calls[0].name, 'collection_commit_roulette');
  assert.equal(h.calls[0].args.p_result.status, 'no_result');assert.equal(h.calls[0].args.p_result.replacement,null);
});

test('confirmed unavailable target is replaced only after the next city is live-verified',async()=>{
  const target=rouletteTicket('BCN',1),candidate={...rouletteTicket('ATH',9),month:'2027-01',market:'de',nights:7,price:140,transfers:1,updated_at:'2027-01-01T00:00:00Z'};
  const response=n=>n===1?{kind:'ok',json:{success:true,data:[]}}:{kind:'ok',json:{success:true,data:[{origin:'BER',destination:'ATH',departure_at:'2027-01-10T06:00:00Z',return_at:'2027-01-17T20:00:00Z',price:135,transfers:1,currency:'EUR'}]}};
  const h=maintenanceHarness([target],response,{replacements:{'BER|any':[candidate]}});
  const first=await h.adapters.priority.step({job:{id:1,planDate:'2027-01-05',checkpoint:priorityCp()},deadline:1_700_000_200_000});
  const second=await h.adapters.priority.step({job:{id:1,planDate:'2027-01-05',checkpoint:first.checkpoint},deadline:1_700_000_200_000});
  const call=h.calls.find(c=>c.name==='collection_commit_roulette');assert.equal(h.requests,2);
  assert.equal(call.args.p_ticket.dest,'BCN');assert.equal(call.args.p_ticket.rank,1);
  assert.equal(call.args.p_result.replacement.dest,'ATH');assert.equal(call.args.p_result.replacement.price,135);
  assert.equal(second.checkpoint.roulette.cursor,1);assert.deepEqual(second.checkpoint.roulette.usedReplacementDests,['BER|ATH']);
});

test('technical roulette failure mutates neither pool nor offer and never starts replacement',async()=>{
  const h=maintenanceHarness([rouletteTicket('BCN',1)],()=>({kind:'refused',refusal:'tooMany'}));
  const result=await h.adapters.priority.step({job:{id:1,planDate:'2027-01-05',checkpoint:priorityCp()},deadline:1_700_000_200_000});
  assert.equal(h.calls.length,0);assert.equal(result.checkpoint.roulette.pendingReplacement,undefined);assert.equal(result.checkpoint.roulette.errors,1);
  assert.equal(result.checkpoint.roulette.cursor,1,'technical failure defers to the next 30-minute pass without blocking later candidates');
  assert.deepEqual(result.checkpoint.roulette.technicalDeferred,[{key:'BER|BCN|any|2027-01-10|2027-01-17',stage:'ticket',cycle:1}]);
});

test('a technical failure skips to the next saved refresh candidate without any storage mutation',async()=>{
  const response=(n,url)=>n===1?{kind:'refused',refusal:'network'}:foundResponse(n,url);
  const h=maintenanceHarness([rouletteTicket('BCN',1),rouletteTicket('ATH',2)],response);
  const first=await h.adapters.priority.step({job:{id:1,planDate:'2027-01-05',checkpoint:priorityCp()},deadline:1_700_000_200_000});
  assert.equal(h.calls.length,0);assert.equal(first.checkpoint.roulette.cursor,1);
  const second=await h.adapters.priority.step({job:{id:1,planDate:'2027-01-05',checkpoint:first.checkpoint},deadline:1_700_000_200_000});
  assert.equal(h.calls[0].name,'collection_commit_roulette');assert.equal(h.calls[0].args.p_ticket.dest,'ATH');
  assert.equal(second.checkpoint.roulette.cursor,2);
});

test('a technical error while checking a replacement preserves the target and defers it without exhausting',async()=>{
  const target=rouletteTicket('BCN',1),candidate={...rouletteTicket('ATH',9),month:'2027-01',market:'de',nights:7,price:140,transfers:1,updated_at:'2027-01-01T00:00:00Z'};
  const response=n=>n===1?{kind:'ok',json:{success:true,data:[]}}:{kind:'refused',refusal:'timeout'};
  const h=maintenanceHarness([target],response,{replacements:{'BER|any':[candidate]}});
  const first=await h.adapters.priority.step({job:{id:1,planDate:'2027-01-05',checkpoint:priorityCp()},deadline:1_700_000_200_000});
  const second=await h.adapters.priority.step({job:{id:1,planDate:'2027-01-05',checkpoint:first.checkpoint},deadline:1_700_000_200_000});
  assert.equal(h.calls.length,0);assert.equal(second.checkpoint.roulette.cursor,1);assert.equal(second.checkpoint.roulette.exhausted,undefined);
  assert.equal(second.checkpoint.roulette.technicalDeferred[0].stage,'replacement');
});

test('refresh owner issues exactly one provider request per saved ticket', async () => {
  const h = maintenanceHarness([rouletteTicket('BCN', 1), rouletteTicket('ATH', 2)], foundResponse);
  // One maintenance step advances the roulette cursor by one ticket (one request).
  await h.adapters.priority.step({ job: { id: 1, planDate: '2027-01-05', checkpoint: priorityCp() }, deadline: 1_700_000_200_000 });
  assert.equal(h.requests, 1, 'a single upstream request for the single ticket processed');
  assert.equal(h.calls.filter(c=>c.name==='collection_commit_roulette').length, 1);
});

test('refresh owner resumes from its saved cursor', async () => {
  const tickets = [rouletteTicket('BCN', 1), rouletteTicket('ATH', 2), rouletteTicket('FCO', 3)];
  const h = maintenanceHarness(tickets, foundResponse);
  const result = await h.adapters.priority.step({
    job: { id: 1, planDate: '2027-01-05', checkpoint: priorityCp(1) },
    deadline: 1_700_000_200_000,
  });
  assert.equal(h.calls[0].args.p_ticket.dest, 'ATH', 'resumed at the second ticket, not the first');
  assert.equal(result.checkpoint.roulette.cursor, 2);
});

test('refresh owner aborts its write when the single collection lease is lost (no parallel refresh)', async () => {
  const h = maintenanceHarness([rouletteTicket('BCN', 1)], foundResponse, { lease: async () => false });
  await assert.rejects(
    () => h.adapters.priority.step({ job: { id: 1, planDate: '2027-01-05', checkpoint: priorityCp() }, deadline: 1_700_000_200_000 }),
    /lease lost/,
  );
});

// ---- Exactly one refresh owner in coordinated mode ------------------------------------

test('coordinator priority is the coordinated-mode refresh owner', async () => {
  const h = maintenanceHarness([rouletteTicket('BCN', 1)], foundResponse);
  await h.adapters.priority.step({job:{id:1,planDate:'2027-01-05',checkpoint:priorityCp()},deadline:1_700_000_200_000});
  assert.equal(h.requests,1);assert.equal(h.calls.filter(c=>c.name==='collection_commit_roulette').length,1);
});

test('standalone refresh workflow is manual fallback only and cannot overlap coordinated mode', () => {
  const workflow = readFileSync(new URL('../.github/workflows/refresh-cheapest-prices.yml', import.meta.url), 'utf8');
  assert.match(workflow, /name: Refresh cheapest carousel prices/);
  assert.doesNotMatch(workflow,/cron:/);
  assert.match(workflow, /vars.COLLECTION_MODE != 'coordinated'/);
  assert.match(workflow, /group: nextout-data-collection/);
  assert.match(workflow, /queue: max/);
  assert.match(workflow, /cancel-in-progress: false/);
  // The only script it RUNS is the refresh script — no selection/MAIN/TAIL/FAST/weekend/audit.
  const runs = [...workflow.matchAll(/run:\s*node\s+scripts\/([\w-]+\.mjs)/g)].map((m) => m[1]);
  assert.deepEqual(runs, ['refresh-roulette-prices.mjs'], 'exactly one script is executed: the refresh script');
});

test('refresh script: bounded to one full pool (≤220 tickets), reads latest pool, one request/ticket', () => {
  const source = readFileSync(new URL('./refresh-roulette-prices.mjs', import.meta.url), 'utf8');
  assert.match(source, /MAX_REFRESH_TICKETS = 220/);
  assert.match(source, /capRefreshTickets\(await latestPool\(supabase\)\)/, 'the read pool is capped before use');
  assert.match(source, /daily_origin_cheapest_pool'\)[\s\S]*?order\('snapshot_at', \{ ascending: false \}\)/, 'reads the latest saved pool');
  assert.doesNotMatch(source, /daily_origin_cheapest_pool'\)\.(?:insert|upsert|update|delete)/, 'never changes membership/rank/order');
  assert.match(source, /from\('offers'\)\.update/, 'unavailable/updated fares touch only the offer');
  assert.match(source, /from\('offers'\)\.delete/, 'an unavailable ticket deletes only its offer (never recreated)');
  assert.match(source, /roulette_price_refresh_checkpoint/, 'checkpoint/resume + lease preserved');
  // Refresh must not trigger any selection or collection stage.
  assert.doesNotMatch(source, /snapshot-daily-origin-cheapest/, 'refresh never runs selection');
  assert.doesNotMatch(source, /claim_flight_price_audit|collection_commit_main|collection_commit_window|fastPlan|tailPlan/, 'no MAIN/TAIL/FAST/audit');
});

test('capRefreshTickets trims to at most 220 tickets and never adds any', async () => {
  const { capRefreshTickets, MAX_REFRESH_TICKETS } = await import('./refresh-roulette-prices.mjs');
  assert.equal(MAX_REFRESH_TICKETS, 220);
  const many = Array.from({ length: 500 }, (_, i) => ({ id: i }));
  assert.equal(capRefreshTickets(many).length, 220, 'capped at 220');
  assert.deepEqual(capRefreshTickets(many).slice(0, 3), many.slice(0, 3), 'keeps saved order, no new tickets');
  assert.deepEqual(capRefreshTickets([{ id: 1 }]), [{ id: 1 }], 'a small pool is unchanged');
  assert.deepEqual(capRefreshTickets(null), [], 'a missing pool is empty, never fabricated');
});

test('published legacy selection/refresh workflow remains preserved behind the mode gate', () => {
  const legacy = readFileSync(new URL('../.github/workflows/snapshot-daily-origin-cheapest.yml', import.meta.url), 'utf8');
  assert.match(legacy, /^\s*schedule:/m);
  assert.match(legacy, /cron: '7,37 \* \* \* \*'/);
  assert.match(legacy, /vars.COLLECTION_MODE != 'coordinated'/);
});

// ---- Source invariants: only the owner mutates pool membership ------------------------

test('no coordinator path performs selection — the nightly owner is the only selector', () => {
  const adapters = readFileSync(new URL('./collection-adapters.mjs', import.meta.url), 'utf8');
  const runCollection = readFileSync(new URL('./run-collection.mjs', import.meta.url), 'utf8');
  const poolWrite = /daily_origin_cheapest_pool'\)\s*\.\s*(?:insert|upsert|update|delete)/;
  // Stage 3: neither coordinator file may write the pool NOR import/call the selection script.
  assert.doesNotMatch(adapters, poolWrite, 'adapters never write pool membership');
  assert.doesNotMatch(runCollection, poolWrite, 'the coordinator session never writes the pool');
  assert.doesNotMatch(adapters, /^\s*import[^\n]*snapshot-daily-origin-cheapest/m, 'main does not import the selection module');
  assert.doesNotMatch(adapters, /publishSnapshot\s*\(/, 'main no longer calls selection');
  assert.doesNotMatch(runCollection, /^\s*import[^\n]*snapshot-daily-origin-cheapest/m, 'the coordinator does not import the selection module');
  assert.doesNotMatch(runCollection, /publishSnapshot\s*\(/, 'end-of-session no longer calls selection');
});

test('standalone legacy refresh remains price-only and never rebuilds the pool', () => {
  const source = readFileSync(new URL('./refresh-roulette-prices.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /daily_origin_cheapest_pool'\)\.(?:insert|upsert|update|delete)/, 'legacy refresh never writes the pool');
  assert.match(source, /from\('offers'\)\.update/, 'legacy refresh updates offers in place');
  assert.match(source, /roulette_price_refresh_checkpoint/, 'legacy refresh keeps its own checkpoint/lease');
});

test('manual nightly selection can publish the guarded rollout epoch while global mode stays paused',()=>{
  const workflow=readFileSync(new URL('../.github/workflows/nightly-cheapest-selection.yml',import.meta.url),'utf8');
  assert.match(workflow,/vars\.COLLECTION_MODE == 'coordinated' \|\| github\.event_name == 'workflow_dispatch'/);
  assert.match(workflow,/snapshot-daily-window-candidates\.mjs/);
});
