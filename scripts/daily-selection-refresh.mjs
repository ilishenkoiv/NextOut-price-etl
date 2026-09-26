// Point confirmation of an ALREADY-SELECTED ticket set (daily roulette pool + carousel/window
// candidates), run immediately after daily selection, in the same coordinator session. This is
// the ONLY place daily selection touches the provider: one exact-price request per selected
// ticket, sequential, at normal pace — it never re-reads the bulk offers/window_prices tables.
//
// Write rule (shared with the ordinary scheduled refresh — collection_commit_roulette /
// collection_commit_window_candidate): an empty or technical response never overwrites the
// ticket's already-selected price. It is simply left out of `confirmed`, so the caller keeps the
// pre-refresh (bulk-selection-time) price/timestamp, which reads as less fresh than a
// freshly-confirmed row until the ordinary market-schedule cadence (priority-market-schedule.mjs)
// confirms it later.
import { classifyResponse } from './check-flight-price-feedback.mjs';
import { marketForOrigin } from '../src/data/origin-markets.js';
import { withPriceProvenance } from './price-provenance.mjs';

export function ticketKey(t) { return [t.origin, t.dest, t.flight_type, t.departure_at, t.return_at].join('|'); }

function requestUrl(ticket) {
  const params = new URLSearchParams({ origin: ticket.origin, destination: ticket.dest,
    departure_at: ticket.departure_at, return_at: ticket.return_at, direct: String(ticket.flight_type === 'direct'),
    market: marketForOrigin(ticket.origin), currency: 'eur', one_way: 'false', limit: '500' });
  return 'https://api.travelpayouts.com/aviasales/v3/prices_for_dates?' + params;
}

// Sequential, normal-pace point confirmation. `deadline` bounds this pass (the session's own
// time budget); a ticket the deadline is reached before reaching is simply never attempted —
// it is neither confirmed nor marked unavailable, left exactly as selection produced it.
export async function pointRefreshTickets(tickets, { provider, clock = Date.now, deadline = Infinity, sourceTable = 'offers' } = {}) {
  const confirmed = new Map(), missed = new Set(), errored = new Set();
  let attempted = 0;
  for (const ticket of tickets) {
    if (clock() + 9000 >= deadline) break;
    attempted++;
    const response = await provider.request(requestUrl(ticket), deadline - 9000);
    const ctx = { origin: ticket.origin, dest: ticket.dest, depart: ticket.departure_at, ret: ticket.return_at, mode: ticket.flight_type };
    const outcome = response.kind === 'ok' ? classifyResponse(response.json, ctx)
      : { status: 'error', detail: response.kind === 'refused' ? 'provider_refused' : 'provider_error' };
    const key = ticketKey(ticket);
    if (outcome.status === 'found') {
      const source = Array.isArray(response.json?.data) && response.json.data.find(row =>
        classifyResponse({ success: true, data: [row] }, ctx).price === outcome.price);
      const updatedAt = new Date(clock()).toISOString();
      const priceSource = withPriceProvenance([{ flight_type: ticket.flight_type, market: marketForOrigin(ticket.origin), updated_at: updatedAt }], sourceTable)[0].price_source;
      confirmed.set(key, {
        price: outcome.price,
        transfers: Number.isInteger(source?.transfers) ? source.transfers : (Number.isInteger(ticket.transfers) ? ticket.transfers : null),
        airline: typeof source?.airline === 'string' ? source.airline : (ticket.airline ?? null),
        updated_at: updatedAt, price_source: priceSource,
      });
    } else if (outcome.status === 'no_result') missed.add(key);
    else errored.add(key);
  }
  return { confirmed, missed, errored, attempted, refreshed: confirmed.size, misses: missed.size, errors: errored.size, total: tickets.length };
}
