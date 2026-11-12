// This module deliberately has no provider/database I/O.  It is the narrow contract shared by
// the collector and the proposal-only owner migration.
export function replacementDecision(surface, outcome, replacement = null) {
  if (!['roulette','carousel'].includes(surface)) throw new Error('Unknown surface');
  if (outcome === 'fresh') return { outcome:'retain_fresh', replacement:null };
  // The carousel must publish an atomically decided fallback even when a recheck did
  // not prove absence (timeout, technical/provider refusal, malformed response).
  // Roulette keeps its established retention-only handling for those outcomes.
  if (outcome !== 'confirmed_absent' && surface !== 'carousel') return { outcome:'retain_unconfirmed', replacement:null };
  if (!replacement) return { outcome:'retain_no_alternate', replacement:null };
  return { outcome:'replaced', replacement };
}

// The roulette daily pool is immutable.  A selected 30-minute recheck may only publish a
// per-ticket verification revision: a fresh verified fare keeps that ticket visible, every
// other outcome excludes it.  It never imports a city from offers or rebuilds membership.
export function rouletteRevisionDecision(outcome) {
  return outcome === 'found'
    ? { visibility:'verified', reason:null }
    : { visibility:'excluded', reason:outcome === 'no_result' ? 'confirmed_absent' : 'unconfirmed' };
}

// The database row, not an environment value, is the durable authority.  The source-side
// feature gate only prevents pre-migration code from querying a table which does not exist yet.
export function selectedRefreshAdmission(control, instant) {
  if (!control?.enabled || control.main12h_rollback) return { active:false, generation:null };
  if (!Number.isSafeInteger(control.generation) || control.generation < 0) return { active:false, generation:null };
  if (!Number.isFinite(instant)) throw new Error('Invalid instant');
  return { active:true, generation:control.generation };
}

export function isFreshConfirmed(row, now) {
  const updated = Date.parse(row?.updated_at);
  return Number.isFinite(updated) && updated >= now - 30 * 60_000 && updated <= now + 5 * 60_000
    && Number.isFinite(Number(row?.price)) && Number(row.price) > 0;
}

export function rouletteAlternate(rows, ticket, now, occupiedDestinations = new Set()) {
  return rows.filter(row => row.origin === ticket.origin && row.flight_type === ticket.flight_type
      && row.dest !== ticket.dest && !occupiedDestinations.has(row.dest) && isFreshConfirmed(row, now))
    .sort((a,b) => Number(a.price) - Number(b.price) || String(a.dest).localeCompare(String(b.dest)))[0] ?? null;
}

export function carouselAlternate(rows, ticket, now) {
  const matching = rows.filter(row => row.origin === ticket.origin && row.flight_type === ticket.flight_type
      && row.dest !== ticket.dest && row.departure_at === ticket.departure_at && row.return_at === ticket.return_at
      && isFreshConfirmed(row,now));
  // An old factual row is the documented no-empty-slide fallback, never a replacement.
  return matching.sort((a,b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)
    || Number(a.price) - Number(b.price)
    || String(a.dest).localeCompare(String(b.dest)))[0] ?? null;
}

export function carouselReplacementKey({epoch,origin,flightType,windowKind,departureAt,returnAt,originalCandidateId}) {
  if (![epoch,origin,flightType,windowKind,departureAt,returnAt,originalCandidateId].every(Boolean)) throw new Error('Incomplete carousel replacement key');
  return [epoch,origin,flightType,windowKind,departureAt,returnAt,originalCandidateId].join('|');
}
