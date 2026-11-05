// Owner-manual, bounded recovery for tickets that are already visible in roulette and carousel.
// It deliberately does not import the coordinator or selection publishers: no MAIN, daily
// selection, broad offer scan, or automatic cadence can enter through this path.
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { CollectionStore, oldRunnerHasStopped } from './collection-store.mjs';
import { CollectionProvider } from './collection-provider.mjs';
import { classifyResponse } from './check-flight-price-feedback.mjs';
import { marketForOrigin } from '../src/data/origin-markets.js';
import { withPriceProvenance } from './price-provenance.mjs';
import { noOtherActiveRuns } from './run-collection.mjs';

export const SELECTED_REFRESH_CANDIDATE = 'owner-manual';
export const SELECTED_REFRESH_MINUTES = 25;
export const ROULETTE_RPC = 'collection_commit_selected_roulette';
export const CAROUSEL_RPC = 'collection_commit_selected_carousel';

export function assertManualSelectedRequest(env = {}) {
  if (env.SELECTED_REFRESH_CANDIDATE !== SELECTED_REFRESH_CANDIDATE) {
    throw new Error('Selected refresh is owner-manual only');
  }
  if (String(env.COLLECTION_SESSION_MINUTES) !== String(SELECTED_REFRESH_MINUTES)) {
    throw new Error('Selected refresh requires the fixed 25-minute session');
  }
}

export function assertSelectedControl(control) {
  if (!control?.enabled || control.main12h_rollback || !Number.isSafeInteger(Number(control.generation)) || Number(control.generation) < 0) {
    throw new Error('Selected refresh disabled, rollback active, or generation invalid');
  }
  return Number(control.generation);
}

const date = value => typeof value === 'string' ? value.slice(0, 10) : null;
const exactIdentity = ticket => ({
  observed_on: ticket.observed_on,
  origin: ticket.origin,
  snapshot_at: ticket.snapshot_at,
  destination_id: ticket.destination_id,
  dest: ticket.dest,
  flight_type: ticket.flight_type,
  departure_at: date(ticket.departure_at),
  return_at: date(ticket.return_at),
});

export function rouletteTicket(ticket) {
  const identity = { ...exactIdentity(ticket), rank: ticket.rank };
  for (const key of ['observed_on', 'origin', 'snapshot_at', 'dest', 'flight_type', 'departure_at', 'return_at', 'rank']) {
    if (identity[key] == null) throw new Error(`Invalid selected roulette ticket: ${key}`);
  }
  delete identity.destination_id;
  return identity;
}

export function carouselTicket(ticket) {
  const identity = exactIdentity(ticket);
  for (const key of ['observed_on', 'origin', 'snapshot_at', 'destination_id', 'dest', 'flight_type', 'departure_at', 'return_at']) {
    if (identity[key] == null) throw new Error(`Invalid selected carousel ticket: ${key}`);
  }
  return identity;
}

function fareFor(ticket, outcome, now) {
  const source = outcome.source ?? {};
  const updated_at = new Date(now()).toISOString();
  return {
    price: outcome.price,
    transfers: Number.isInteger(source.transfers) ? source.transfers : (Number.isInteger(ticket.transfers) ? ticket.transfers : null),
    airline: typeof source.airline === 'string' ? source.airline : (ticket.airline ?? null),
    updated_at,
    price_source: withPriceProvenance([{ flight_type: ticket.flight_type, market: marketForOrigin(ticket.origin), updated_at }], 'selected_manual')[0].price_source,
  };
}

export function rouletteResult(ticket, outcome, now = Date.now) {
  if (outcome.status === 'found') return { status: 'found', fare: fareFor(ticket, outcome, now) };
  return outcome.status === 'no_result' ? { status: 'no_result' } : { status: 'error', detail: outcome.detail ?? 'provider_error' };
}

export function carouselResult(ticket, outcome, now = Date.now) {
  if (outcome.status === 'found') {
    // The target RPC rejects a replacement whose factual destination identity differs from the
    // selected carousel ticket. Keep those fields explicit rather than letting provider output
    // invent or substitute a destination.
    return { status: 'found', fare: fareFor(ticket, outcome, now), replacement: carouselTicket(ticket) };
  }
  if (outcome.status === 'no_result') return { status: 'confirmed_absent', replacement: carouselTicket(ticket) };
  const status = ['technical', 'timeout', 'rate_limit', 'unconfirmed'].includes(outcome.status) ? outcome.status : 'error';
  return { status, detail: outcome.detail ?? 'provider_error', replacement: carouselTicket(ticket) };
}

function requestUrl(ticket) {
  const params = new URLSearchParams({ origin: ticket.origin, destination: ticket.dest, departure_at: date(ticket.departure_at),
    return_at: date(ticket.return_at), direct: String(ticket.flight_type === 'direct'), market: marketForOrigin(ticket.origin),
    currency: 'eur', one_way: 'false', limit: '500' });
  return 'https://api.travelpayouts.com/aviasales/v3/prices_for_dates?' + params;
}

export async function refreshOutcome(ticket, provider, deadline, now = Date.now) {
  const response = await provider.request(requestUrl(ticket), deadline - 9000);
  if (response.kind !== 'ok') return { status: response.kind === 'timeout' ? 'timeout' : 'technical', detail: 'provider_error' };
  const context = { origin: ticket.origin, dest: ticket.dest, depart: date(ticket.departure_at), ret: date(ticket.return_at), mode: ticket.flight_type };
  const classified = classifyResponse(response.json, context);
  if (classified.status !== 'found') return classified;
  const source = Array.isArray(response.json?.data) && response.json.data.find(row =>
    classifyResponse({ success: true, data: [row] }, context).price === classified.price);
  return { ...classified, source, checked_at: new Date(now()).toISOString() };
}

async function selectedControl(db) {
  const { data, error } = await db.from('selected_price_refresh_control')
    .select('singleton,enabled,generation,main12h_rollback').eq('singleton', true).maybeSingle();
  if (error) throw new Error(`Selected refresh control read failed: ${error.message}`);
  return data;
}

async function latestRoulette(db) {
  const { data: latest, error } = await db.from('daily_origin_cheapest_pool').select('snapshot_at,observed_on')
    .order('snapshot_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Selected roulette epoch read failed: ${error.message}`);
  if (!latest) return [];
  const { data, error: rowsError } = await db.from('daily_origin_cheapest_pool')
    .select('observed_on,snapshot_at,origin,dest,flight_type,rank,departure_at,return_at,transfers,airline')
    .eq('snapshot_at', latest.snapshot_at).order('origin').order('flight_type').order('rank');
  if (rowsError) throw new Error(`Selected roulette ticket read failed: ${rowsError.message}`);
  return data ?? [];
}

async function latestCarousel(db) {
  const { data: epoch, error } = await db.from('daily_window_candidate_epochs').select('observed_on,snapshot_at')
    .order('snapshot_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Selected carousel epoch read failed: ${error.message}`);
  if (!epoch) return [];
  const { data, error: rowsError } = await db.from('daily_window_candidates')
    .select('observed_on,snapshot_at,origin,destination_id,dest,flight_type,departure_at,return_at,transfers,airline')
    .eq('snapshot_at', epoch.snapshot_at).order('origin').order('departure_at').order('flight_type');
  if (rowsError) throw new Error(`Selected carousel ticket read failed: ${rowsError.message}`);
  return data ?? [];
}

async function commit(db, store, name, args) {
  if (!await store.lease()) throw new Error('Selected refresh forbidden: collection lease lost');
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`Selected refresh RPC failed: ${name} (${error.message})`);
  if (data !== true) throw new Error(`Selected refresh RPC rejected: ${name}`);
}

export async function runSelectedRefresh({ env = process.env, db: injectedDb, provider: injectedProvider, store: injectedStore,
  now = Date.now, noOtherRuns = noOtherActiveRuns, oldStopped = oldRunnerHasStopped } = {}) {
  // This is intentionally first: an unsupported dispatch cannot construct a provider, claim a
  // lease, or accidentally reach any normal coordinator work.
  assertManualSelectedRequest(env);
  for (const key of ['TP_TOKEN', 'SUPABASE_SERVICE_KEY', 'GITHUB_TOKEN']) if (!env[key]) throw new Error(`Missing required ${key}`);
  if (!await noOtherRuns(env)) throw new Error('Selected refresh refused: another workflow is active or unknown');
  const db = injectedDb ?? createClient(env.SUPABASE_URL || 'https://xpalogebawoljlafsafs.supabase.co', env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false, autoRefreshToken: false } });
  const generation = assertSelectedControl(await selectedControl(db));
  const store = injectedStore ?? new CollectionStore(db, randomUUID(), env.GITHUB_RUN_ID);
  const previous = await store.inspect();
  if (!await oldStopped(previous, { repository: env.GITHUB_REPOSITORY, token: env.GITHUB_TOKEN, now })) {
    throw new Error('Selected refresh refused: previous lease holder is not confirmed stopped');
  }
  if (!await store.claim(previous?.owner ?? null)) throw new Error('Selected refresh refused: collection lease unavailable');
  const deadline = now() + SELECTED_REFRESH_MINUTES * 60_000;
  const provider = injectedProvider ?? new CollectionProvider({ token: env.TP_TOKEN, lease: () => store.lease() });
  const summary = { roulette: { attempted: 0 }, carousel: { attempted: 0 }, generation };
  try {
    for (const ticket of await latestRoulette(db)) {
      if (now() + 9000 >= deadline) break;
      const identity = rouletteTicket(ticket), outcome = await refreshOutcome(ticket, provider, deadline, now);
      await commit(db, store, ROULETTE_RPC, { ...store.args(), p_generation: generation, p_ticket: identity, p_result: rouletteResult(ticket, outcome, now) });
      summary.roulette.attempted++;
    }
    for (const ticket of await latestCarousel(db)) {
      if (now() + 9000 >= deadline) break;
      const identity = carouselTicket(ticket), outcome = await refreshOutcome(ticket, provider, deadline, now);
      await commit(db, store, CAROUSEL_RPC, { p_ticket: identity, p_generation: generation, p_result: carouselResult(ticket, outcome, now) });
      summary.carousel.attempted++;
    }
    return summary;
  } finally {
    await store.release();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSelectedRefresh().then(summary => console.log(JSON.stringify({ event: 'selected_manual_refresh_complete', ...summary })))
    .catch(error => { console.error(error.message || error); process.exitCode = 1; });
}
