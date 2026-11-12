import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptedCarouselRun, assertManualSelectedRequest, assertSelectedControl, berlinDay, carouselResult, carouselTicket,
  refreshSelectedRoulette, rouletteResult, rouletteTicket } from './selected-refresh-recovery.mjs';
import { withCurrentRouletteRevisionState } from './selected-price-refresh-contract.mjs';

const ticket = { observed_on: '2026-11-05', snapshot_at: '2026-11-05T05:00:00Z', origin: 'BER', dest: 'BCN', destination_id: 'barcelona',
  flight_type: 'any', rank: 1, departure_at: '2026-12-04', return_at: '2026-12-07', transfers: 1 };

test('only the explicit fixed-duration owner-manual request is admitted before any provider or lease work', () => {
  assert.throws(() => assertManualSelectedRequest({}), /owner-manual only/);
  assert.throws(() => assertManualSelectedRequest({ SELECTED_REFRESH_CANDIDATE: 'owner-manual', COLLECTION_SESSION_MINUTES: '15' }), /fixed 25-minute/);
  assert.doesNotThrow(() => assertManualSelectedRequest({ SELECTED_REFRESH_CANDIDATE: 'owner-manual', COLLECTION_SESSION_MINUTES: '25' }));
});

test('normal selected Roulette refresh invokes the shared path only for an enabled stale ticket', async () => {
  const instant = Date.parse('2026-11-05T12:00:00Z');
  const stale = { ...ticket, flight_type: 'direct', transfers: 0, price: 84, source_updated_at: '2026-11-05T11:29:59Z' };
  const calls = []; let refreshed = 0;
  const result = await refreshSelectedRoulette({
    db: { rpc: async (name, args) => { calls.push({ name, args }); return { data: true, error: null }; } },
    store: { args: () => ({ p_owner: 'owner', p_token: 9 }), lease: async () => true }, provider: null,
    deadline: instant + 60_000, now: () => instant,
    control: { enabled: true, generation: 7, main12h_rollback: false },
    readTickets: async () => [stale], regular: true, staleOnly: true,
    refresh: async () => { refreshed++; return { status: 'found', price: 91, source: { transfers: 0 } }; },
  });
  assert.deepEqual(result, { active: true, generation: 7, attempted: 1, stale: 1 });
  assert.equal(refreshed, 1); assert.equal(calls.length, 1); assert.equal(calls[0].name, 'collection_commit_selected_roulette');
  assert.equal(calls[0].args.p_generation, 7, 'the RPC receives the admitted control generation');
  assert.equal(calls[0].args.p_result.status, 'found');
});

test('normal selected Roulette refresh is a disabled or rollback no-op before ticket reads', async () => {
  const instant = Date.parse('2026-11-05T12:00:00Z');
  for (const control of [{ enabled: false, generation: 7, main12h_rollback: false }, { enabled: true, generation: 7, main12h_rollback: true }]) {
    let reads = 0;
    const result = await refreshSelectedRoulette({ db: {}, store: {}, deadline: instant + 60_000, now: () => instant,
      control, regular: true, staleOnly: true, readTickets: async () => { reads++; return []; } });
    assert.deepEqual(result, { active: false, generation: null, attempted: 0, stale: 0 });
    assert.equal(reads, 0);
  }
});

test('normal selected Roulette refresh leaves fresh selected fares untouched', async () => {
  const instant = Date.parse('2026-11-05T12:00:00Z');
  const fresh = { ...ticket, flight_type: 'direct', transfers: 0, price: 84, source_updated_at: '2026-11-05T11:45:00Z' };
  let refreshed = 0;
  const result = await refreshSelectedRoulette({ db: {}, store: {}, deadline: instant + 60_000, now: () => instant,
    control: { enabled: true, generation: 1, main12h_rollback: false }, regular: true, staleOnly: true,
    readTickets: async () => [fresh], refresh: async () => { refreshed++; throw new Error('fresh ticket must not refresh'); } });
  assert.deepEqual(result, { active: true, generation: 1, attempted: 0, stale: 0 });
  assert.equal(refreshed, 0);
});

test('normal selected Roulette refresh fences a lost lease before provider work and preserves the admitted generation', async () => {
  const instant = Date.parse('2026-11-05T12:00:00Z');
  const stale = { ...ticket, flight_type: 'direct', transfers: 0, price: 84, source_updated_at: '2026-11-05T11:29:59Z' };
  let refreshed = 0; let rpc = 0;
  await assert.rejects(() => refreshSelectedRoulette({
    db: { rpc: async () => { rpc++; return { data: true, error: null }; } },
    store: { args: () => ({ p_owner: 'owner', p_token: 9 }), lease: async () => false }, provider: null,
    deadline: instant + 60_000, now: () => instant,
    control: { enabled: true, generation: 11, main12h_rollback: false }, regular: true, staleOnly: true,
    readTickets: async () => [stale], refresh: async () => { refreshed++; return { status: 'found', price: 91, source: { transfers: 0 } }; },
  }), /collection lease lost/);
  assert.equal(refreshed, 0); assert.equal(rpc, 0);
});

test('target control admits only enabled non-rollback integer generations', () => {
  assert.equal(assertSelectedControl({ enabled: true, generation: 1, main12h_rollback: false }), 1);
  for (const control of [{ enabled: false, generation: 1, main12h_rollback: false }, { enabled: true, generation: 1, main12h_rollback: true }, { enabled: true, generation: 'bad', main12h_rollback: false }]) {
    assert.throws(() => assertSelectedControl(control), /disabled, rollback active, or generation invalid/);
  }
});

test('roulette payload matches the live owner/token/generation contract and retains absent price without a verified pool10 alternate', () => {
  assert.deepEqual(rouletteTicket(ticket), { observed_on: ticket.observed_on, origin: 'BER', snapshot_at: ticket.snapshot_at, dest: 'BCN', flight_type: 'any', departure_at: '2026-12-04', return_at: '2026-12-07', rank: 1 });
  const result = rouletteResult(ticket, { status: 'found', price: 99, source: { transfers: 1 } }, () => Date.parse('2026-11-05T06:00:00Z'));
  assert.equal(result.status, 'found'); assert.equal(result.fare.price, 99); assert.ok(result.fare.updated_at);
  assert.equal(result.fare.airline, null, 'roulette outcome does not require an airline from the pool ticket');
  assert.deepEqual(rouletteResult(ticket, { status: 'no_result' }), { status: 'confirmed_absent', outcome: 'retained' });
  assert.deepEqual(rouletteResult(ticket, { status: 'timeout' }), { status: 'unconfirmed', outcome: 'retained', detail: 'provider_error' });
});

test('selected roulette reads only supported pool columns', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./selected-refresh-recovery.mjs', import.meta.url), 'utf8'));
  const rouletteRead = source.match(/async function latestRoulette[\s\S]*?\n}\n\nexport function berlinDay/)[0];
  assert.match(rouletteRead, /price,source_updated_at,price_source/);
  assert.doesNotMatch(rouletteRead, /airline/);
  assert.match(rouletteRead, /roulette_pool_ticket_revisions/);
  assert.match(rouletteRead, /visibility,reason,generation/);
  assert.match(rouletteRead, /\.eq\('generation', generation\)/);
});

test('carousel payload keeps factual selected identity and preserves unconfirmed retention when no alternate is current-confirmed', () => {
  const identity = carouselTicket(ticket);
  assert.deepEqual(Object.keys(identity).sort(), ['departure_at', 'dest', 'destination_id', 'flight_type', 'observed_on', 'origin', 'return_at', 'snapshot_at']);
  const result = carouselResult(ticket, { status: 'no_result' });
  assert.deepEqual(result, { status: 'confirmed_absent', outcome: 'retained' });
  assert.deepEqual(carouselResult(ticket, { status: 'technical', detail: 'provider_error' }),
    { status: 'unconfirmed', outcome: 'retained', detail: 'provider_error' });
  const found = carouselResult(ticket, { status: 'found', price: 99, source: { transfers: 1 } }, () => Date.parse('2026-11-05T06:00:00Z'));
  assert.equal(found.status, 'found'); assert.deepEqual(found.replacement, identity); assert.equal(found.fare.price, 99);
});

test('manual recovery shares the primary exact-pool and exact-date alternate boundaries', () => {
  const clock = () => Date.parse('2026-11-05T06:00:00Z');
  const pool = Array.from({ length: 10 }, (_, index) => ({ ...ticket, rank: index + 1, dest: index === 0 ? 'BCN' : `D${index}`,
    price: 100 - index, transfers: 1, source_updated_at: '2026-11-05T05:45:00Z', price_source: { source: 'fixture' } }));
  const roulette = rouletteResult(ticket, { status: 'no_result' }, clock,
    withCurrentRouletteRevisionState(pool, pool.map(row => ({ ...row, visibility: 'verified', reason: null, generation: 1 }))));
  assert.equal(roulette.outcome, 'replaced'); assert.equal(roulette.replacement.dest, 'D1');
  const candidates = [{ ...ticket, position: 1, price: 99, exact_observed_at: '2026-11-05T05:45:00Z', refresh_status: 'fresh', price_source: {} },
    { ...ticket, destination_id: 'rome', dest: 'FCO', position: 2, price: 88, exact_observed_at: '2026-11-05T05:45:00Z', refresh_status: 'fresh', price_source: {} }];
  for (const outcome of [{ status: 'no_result' }, { status: 'technical', detail: 'provider_error' }, { status: 'timeout', detail: 'timeout' }]) {
    const carousel = carouselResult(ticket, outcome, clock, candidates);
    assert.equal(carousel.outcome, 'replaced'); assert.equal(carousel.replacement.destination_id, 'rome');
  }
  const unavailableCarousel = carouselResult(ticket, { status: 'no_result' }, clock,
    candidates.map(row => row.dest === 'FCO' ? { ...row, refresh_status: 'unavailable' } : row));
  assert.equal(unavailableCarousel.outcome, 'retained', 'manual recovery shares persisted carousel availability');
});

test('current Berlin-day per-origin carousel run accepts only its declared exact candidate set', () => {
  const run = { observed_on: '2026-11-05', origin: 'BER', snapshot_at: ticket.snapshot_at, contract_version: 1, candidate_rows: 2, exact_request_groups: 2 };
  const candidates = [ticket, { ...ticket, destination_id: 'rome', dest: 'FCO', departure_at: '2026-12-11', return_at: '2026-12-14' }];
  assert.deepEqual(acceptedCarouselRun(run, candidates, '2026-11-05'), candidates);
  assert.equal(berlinDay(() => Date.parse('2026-11-05T23:30:00Z')), '2026-11-06');
});

test('absent, mismatched, and stale carousel runs are no-ops before an RPC ticket can form', () => {
  const run = { observed_on: '2026-11-05', origin: 'BER', snapshot_at: ticket.snapshot_at, contract_version: 1, candidate_rows: 1, exact_request_groups: 1 };
  assert.deepEqual(acceptedCarouselRun(run, [], '2026-11-05'), []);
  assert.deepEqual(acceptedCarouselRun({ ...run, candidate_rows: 2 }, [ticket], '2026-11-05'), []);
  assert.deepEqual(acceptedCarouselRun(run, [ticket], '2026-11-06'), []);
});

test('carousel reader uses the per-origin run triple and not the legacy global epoch', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./selected-refresh-recovery.mjs', import.meta.url), 'utf8'));
  const reader = source.match(/export async function latestCarousel[\s\S]*?\n}\n\nasync function commit/)[0];
  assert.match(reader, /daily_origin_window_candidate_runs/);
  assert.match(reader, /daily_origin_window_candidates/);
  assert.match(reader, /exact_price,exact_observed_at,refresh_status,price_source/);
  assert.match(reader, /\.eq\('observed_on', run\.observed_on\)\.eq\('origin', run\.origin\)\.eq\('snapshot_at', run\.snapshot_at\)/);
  assert.doesNotMatch(reader, /daily_window_candidate_epochs|daily_window_candidates/);
});

test('manual selected runner contains no coordinator, MAIN, or daily-selection entry point', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./selected-refresh-recovery.mjs', import.meta.url), 'utf8'));
  assert.doesNotMatch(source, /runDueDailySelection|createAdapters|\.main\.step|snapshot-daily-/);
});

test('the explicit owner-manual wrapper remains separately admitted and retains its non-stale-only roulette sweep', async () => {
  const source = await import('node:fs/promises').then(fs => fs.readFile(new URL('./selected-refresh-recovery.mjs', import.meta.url), 'utf8'));
  const runner = source.match(/export async function runSelectedRefresh[\s\S]*?\n}\n\nif \(process\.argv/)[0];
  assert.match(runner, /assertManualSelectedRequest\(env\);/);
  assert.ok(runner.indexOf('assertManualSelectedRequest(env);') < runner.indexOf('new CollectionProvider'), 'manual admission remains before provider construction');
  assert.match(runner, /staleOnly: false/);
});

test('recovery migration keeps retained carousel absence as a no-op and decomposes a verified alternate into exact base facts', async () => {
  const sql = await import('node:fs/promises').then(fs => fs.readFile(new URL('../migrations/20261106120000_selected_price_refresh_recovery.sql', import.meta.url), 'utf8'));
  assert.match(sql, /v_outcome='retained' then return true/);
  assert.match(sql, /v_candidate->>'refresh_status' is distinct from 'fresh'/);
  assert.match(sql, /r\.visibility='verified' and r\.reason is null/);
  assert.match(sql, /p_ticket,p_generation,jsonb_build_object\('status','confirmed_absent'\)/);
  assert.match(sql, /jsonb_build_object\('status','found','fare'/);
});
