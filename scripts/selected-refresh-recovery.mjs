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
import { carouselReplacement, retainedResult, rouletteReplacement, selectCarouselAlternate, selectRouletteAlternate,
  isBerlinSelectedRefreshDaytime, isCurrentConfirmedFare, selectedRefreshAdmission,
  withCurrentRouletteRevisionState } from './selected-price-refresh-contract.mjs';

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

export function rouletteResult(ticket, outcome, now = Date.now, pool = []) {
  if (outcome.status === 'found') return { status: 'found', fare: fareFor(ticket, outcome, now) };
  if (outcome.status === 'no_result') {
    const replacement = rouletteReplacement(selectRouletteAlternate(pool, ticket, now()));
    return replacement
      ? { status: 'confirmed_absent', outcome: 'replaced', replacement }
      : { status: 'confirmed_absent', outcome: 'retained' };
  }
  return retainedResult(outcome);
}

export function carouselResult(ticket, outcome, now = Date.now, candidates = []) {
  if (outcome.status === 'found') {
    // The target RPC rejects a replacement whose factual destination identity differs from the
    // selected carousel ticket. Keep those fields explicit rather than letting provider output
    // invent or substitute a destination.
    return { status: 'found', fare: fareFor(ticket, outcome, now), replacement: carouselTicket(ticket) };
  }
  const replacement = carouselReplacement(selectCarouselAlternate(candidates, ticket, now()));
  return replacement
    ? { status: 'confirmed_absent', outcome: 'replaced', replacement }
    : retainedResult(outcome);
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

async function latestRoulette(db, generation) {
  const { data: latest, error } = await db.from('daily_origin_cheapest_pool').select('snapshot_at,observed_on')
    .order('snapshot_at', { ascending: false }).limit(1).maybeSingle();
  if (error) throw new Error(`Selected roulette epoch read failed: ${error.message}`);
  if (!latest) return [];
  const { data, error: rowsError } = await db.from('daily_origin_cheapest_pool')
    .select('observed_on,snapshot_at,origin,dest,flight_type,rank,departure_at,return_at,transfers,price,source_updated_at,price_source')
    .eq('snapshot_at', latest.snapshot_at).order('origin').order('flight_type').order('rank');
  if (rowsError) throw new Error(`Selected roulette ticket read failed: ${rowsError.message}`);
  const { data: revisions, error: revisionsError } = await db.from('roulette_pool_ticket_revisions')
    .select('snapshot_at,origin,flight_type,rank,dest,departure_at,return_at,visibility,reason,generation')
    .eq('snapshot_at', latest.snapshot_at).eq('generation', generation)
    .order('origin').order('flight_type').order('rank');
  if (revisionsError) throw new Error(`Selected roulette revision read failed: ${revisionsError.message}`);
  return withCurrentRouletteRevisionState(data ?? [], revisions ?? []);
}

export function berlinDay(now = Date.now) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date(now()));
  const value = key => parts.find(part => part.type === key)?.value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

// A run is admitted only when its declared publication counts describe precisely the rows loaded
// through its own (observed_on, origin, snapshot_at) identity. This deliberately turns an absent,
// stale, or partially replaced run into a truthful no-op before any provider or carousel RPC work.
export function acceptedCarouselRun(run, candidates, observedOn) {
  if (run?.observed_on !== observedOn || run.contract_version !== 1 || !Number.isInteger(run.candidate_rows)
    || !Number.isInteger(run.exact_request_groups) || run.candidate_rows < 1 || run.exact_request_groups < 1) return [];
  if (candidates.length !== run.candidate_rows) return [];
  const groups = new Set(candidates.map(candidate => [candidate.flight_type, date(candidate.departure_at), date(candidate.return_at)].join('|')));
  if (groups.size !== run.exact_request_groups) return [];
  return candidates;
}

export async function latestCarousel(db, now = Date.now) {
  const observedOn = berlinDay(now);
  const { data: runs, error } = await db.from('daily_origin_window_candidate_runs')
    .select('observed_on,origin,snapshot_at,contract_version,candidate_rows,exact_request_groups')
    .eq('observed_on', observedOn).eq('contract_version', 1).order('origin');
  if (error) throw new Error(`Selected carousel run read failed: ${error.message}`);
  const tickets = [];
  for (const run of runs ?? []) {
    const { data: candidates, error: rowsError } = await db.from('daily_origin_window_candidates')
      .select('observed_on,snapshot_at,origin,destination_id,dest,flight_type,departure_at,return_at,position,transfers,airline,exact_price,exact_observed_at,refresh_status,price_source')
      .eq('observed_on', run.observed_on).eq('origin', run.origin).eq('snapshot_at', run.snapshot_at)
      .order('departure_at').order('flight_type');
    if (rowsError) throw new Error(`Selected carousel ticket read failed: ${rowsError.message}`);
    tickets.push(...acceptedCarouselRun(run, (candidates ?? []).map(candidate => ({ ...candidate, price: candidate.exact_price })), observedOn));
  }
  return tickets;
}

async function commit(db, store, name, args) {
  if (!await store.lease()) throw new Error('Selected refresh forbidden: collection lease lost');
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(`Selected refresh RPC failed: ${name} (${error.message})`);
  if (data !== true) throw new Error(`Selected refresh RPC rejected: ${name}`);
}

// The normal coordinator reuses this exact Roulette path after it has claimed the scheduler
// lease.  Regular passes are deliberately stale-only and daytime-only; the retained
// owner-manual wrapper passes `staleOnly: false` and keeps its explicit admission separately.
export async function refreshSelectedRoulette({ db, store, provider, deadline, now = Date.now,
  control: suppliedControl, readControl = selectedControl, readTickets = latestRoulette,
  refresh = refreshOutcome, staleOnly = false, regular = false } = {}) {
  const empty = { active: false, generation: null, attempted: 0, stale: 0 };
  if (regular && !isBerlinSelectedRefreshDaytime(now())) return empty;
  const admission = selectedRefreshAdmission(suppliedControl ?? await readControl(db));
  if (!admission.active) return empty;
  const tickets = await readTickets(db, admission.generation);
  const targets = (tickets ?? []).filter(ticket => !staleOnly || !isCurrentConfirmedFare(ticket, now(), ticket.source_updated_at));
  const summary = { active: true, generation: admission.generation, attempted: 0, stale: targets.length };
  for (const ticket of targets) {
    if (now() + 9000 >= deadline) break;
    if (!await store.lease()) throw new Error('Selected refresh forbidden: collection lease lost');
    const identity = rouletteTicket(ticket), outcome = await refresh(ticket, provider, deadline, now);
    await commit(db, store, ROULETTE_RPC, {
      ...store.args(), p_generation: admission.generation, p_ticket: identity,
      p_result: rouletteResult(ticket, outcome, now, tickets),
    });
    summary.attempted++;
  }
  return summary;
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
  const control = await selectedControl(db);
  const generation = assertSelectedControl(control);
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
    const roulette = await refreshSelectedRoulette({ db, store, provider, deadline, now, control, staleOnly: false });
    summary.roulette.attempted = roulette.attempted;
    const carouselTickets = await latestCarousel(db, now);
    for (const ticket of carouselTickets) {
      if (now() + 9000 >= deadline) break;
      const identity = carouselTicket(ticket), outcome = await refreshOutcome(ticket, provider, deadline, now);
      await commit(db, store, CAROUSEL_RPC, { p_ticket: identity, p_generation: generation, p_result: carouselResult(ticket, outcome, now, carouselTickets) });
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
