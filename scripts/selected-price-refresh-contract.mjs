// Pure selected-price refresh decisions shared by the primary coordinator and the retained
// owner-manual recovery entry point. A replacement is permitted only from the immutable selected
// set and only when its exact fare is currently confirmed; inconclusive checks retain the ticket.
export const SELECTED_PRICE_FRESH_MS = 30 * 60_000;
export const SELECTED_PRICE_MAX_FUTURE_MS = 5 * 60_000;

const date = value => typeof value === 'string' ? value.slice(0, 10) : null;
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const validTransfers = (value, flightType) => Number.isInteger(Number(value)) && Number(value) >= 0
  && (flightType !== 'direct' || Number(value) === 0);

export function selectedRefreshAdmission(control) {
  if (!control?.enabled || control.main12h_rollback || !Number.isSafeInteger(Number(control.generation)) || Number(control.generation) < 0) {
    return { active: false, generation: null };
  }
  return { active: true, generation: Number(control.generation) };
}

export function isBerlinSelectedRefreshDaytime(now = Date.now) {
  if (!Number.isFinite(now)) throw new Error('Invalid selected refresh clock');
  const hour = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hourCycle: 'h23' })
    .formatToParts(new Date(now)).find(part => part.type === 'hour')?.value);
  return Number.isInteger(hour) && hour >= 7 && hour < 23;
}

export function isCurrentConfirmedFare(row, now = Date.now, timestamp = row?.source_updated_at ?? row?.exact_observed_at ?? row?.updated_at) {
  const observedAt = Date.parse(timestamp ?? '');
  return positive(row?.price) && validTransfers(row?.transfers, row?.flight_type)
    && Number.isFinite(observedAt) && observedAt >= now - SELECTED_PRICE_FRESH_MS
    && observedAt <= now + SELECTED_PRICE_MAX_FUTURE_MS;
}

function sameRoulettePool(row, ticket) {
  return row?.observed_on === ticket?.observed_on && row?.snapshot_at === ticket?.snapshot_at
    && row?.origin === ticket?.origin;
}

function sameRouletteRevision(row, revision) {
  return sameRoulettePool(row, revision) && row?.flight_type === revision?.flight_type
    && Number(row?.rank) === Number(revision?.rank) && row?.dest === revision?.dest
    && date(row?.departure_at) === date(revision?.departure_at) && date(row?.return_at) === date(revision?.return_at);
}

// Pool membership is immutable, but its displayed availability is not. A missing, excluded, or
// non-verified revision is deliberately not an alternate authority: retain rather than revive a
// city that the persisted selected revision has already made unavailable.
export function withCurrentRouletteRevisionState(pool, revisions) {
  const state = Array.isArray(revisions) ? revisions : [];
  return (Array.isArray(pool) ? pool : []).map(row => {
    const matches = state.filter(revision => sameRouletteRevision(row, revision));
    const revision = matches.length === 1 ? matches[0] : null;
    return { ...row, revision_visibility: revision?.visibility ?? null, revision_reason: revision?.reason ?? null };
  });
}

function hasVerifiedAvailableRouletteRevision(row) {
  return row?.revision_visibility === 'verified' && row?.revision_reason === null;
}

// A valid daily pool is exactly one origin's immutable ranks 1–10. A partial/replayed/mixed
// pool is not an authority for an alternate, even if it happens to contain a fresh price.
export function remainingExactPool10(pool, ticket) {
  const members = (Array.isArray(pool) ? pool : []).filter(row => sameRoulettePool(row, ticket));
  const ranks = members.map(row => Number(row.rank));
  if (members.length !== 10 || new Set(ranks).size !== 10 || ranks.some(rank => !Number.isInteger(rank) || rank < 1 || rank > 10)
    || new Set(members.map(row => row.dest)).size !== 10) return [];
  return members.filter(row => row.dest !== ticket.dest)
    .sort((a, b) => Number(a.rank) - Number(b.rank) || String(a.dest).localeCompare(String(b.dest)));
}

export function selectRouletteAlternate(pool, ticket, now = Date.now) {
  return remainingExactPool10(pool, ticket).find(row => hasVerifiedAvailableRouletteRevision(row)
    && isCurrentConfirmedFare(row, now, row.source_updated_at)) ?? null;
}

export function selectCarouselAlternate(candidates, ticket, now = Date.now) {
  return (Array.isArray(candidates) ? candidates : [])
    .filter(row => row?.observed_on === ticket?.observed_on && row?.snapshot_at === ticket?.snapshot_at
      && row?.origin === ticket?.origin && row?.flight_type === ticket?.flight_type
      && date(row?.departure_at) === date(ticket?.departure_at) && date(row?.return_at) === date(ticket?.return_at)
      && row?.destination_id !== ticket?.destination_id && row?.dest !== ticket?.dest)
    .filter(row => row?.refresh_status === 'fresh' && isCurrentConfirmedFare(row, now, row.exact_observed_at))
    .sort((a, b) => Number(a.position) - Number(b.position) || String(a.destination_id).localeCompare(String(b.destination_id)))[0] ?? null;
}

function fareFrom(row, timestamp) {
  return {
    price: Number(row.price),
    transfers: Number(row.transfers),
    airline: typeof row.airline === 'string' ? row.airline : null,
    updated_at: timestamp,
    price_source: row.price_source ?? {},
  };
}

export function rouletteReplacement(row) {
  if (!row) return null;
  return {
    observed_on: row.observed_on, snapshot_at: row.snapshot_at, origin: row.origin, dest: row.dest,
    flight_type: row.flight_type, rank: row.rank, departure_at: date(row.departure_at), return_at: date(row.return_at),
    ...fareFrom(row, row.source_updated_at),
  };
}

export function carouselReplacement(row) {
  if (!row) return null;
  return {
    observed_on: row.observed_on, snapshot_at: row.snapshot_at, origin: row.origin, destination_id: row.destination_id,
    dest: row.dest, flight_type: row.flight_type, departure_at: date(row.departure_at), return_at: date(row.return_at),
    ...fareFrom(row, row.exact_observed_at),
  };
}

export function retainedResult(outcome) {
  if (outcome?.status === 'no_result') return { status: 'confirmed_absent', outcome: 'retained' };
  return { status: 'unconfirmed', outcome: 'retained', detail: outcome?.detail ?? 'provider_error' };
}
