// Revalidate only the exact tickets present in the latest roulette snapshot.
//
// This is deliberately separate from the main month sweep. It makes at most one partner request
// per current roulette ticket, updates a confirmed fare in-place, and deletes that exact cached
// offer only when a successful upstream response confirms it is no longer available. Network,
// HTTP and malformed-body failures never destroy the last known offer.

import { withPriceProvenance } from './price-provenance.mjs';
import { githubIsIdle } from './check-flight-price-feedback.mjs';
import { createClient } from '@supabase/supabase-js';
import { pathToFileURL } from 'node:url';
import { marketForOrigin } from '../src/data/origin-markets.js';

const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xpalogebawoljlafsafs.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const TP_TOKEN = process.env.TP_TOKEN;
const TIMEOUT_MS = 8000;
const INTERVAL_MS = 125; // 80% of the documented 600 requests/minute limit.
const PAGE = 1000;
export const ROULETTE_REFRESH_WORKFLOW = 'Daily cheapest offers snapshot';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function ticketKey(row) {
  return [row.origin, row.dest, row.flight_type, row.departure_at, row.return_at || ''].join('|');
}

export function selectExactFare(data, ticket) {
  if (!Array.isArray(data)) return null;
  let best = null;
  for (const row of data) {
    const departure = typeof row.departure_at === 'string' ? row.departure_at.slice(0, 10) : null;
    const returning = typeof row.return_at === 'string' ? row.return_at.slice(0, 10) : null;
    const price = typeof row.price === 'number' ? Math.round(row.price) : NaN;
    if (departure !== ticket.departure_at || (returning || null) !== (ticket.return_at || null) || !(price > 0)) continue;
    if (!best || price < best.price) {
      best = {
        price,
        transfers: Number.isFinite(row.transfers) ? Math.trunc(row.transfers) : 0,
        airline: typeof row.airline === 'string' ? row.airline : null,
      };
    }
  }
  return best;
}

export function buildTicketUrl(ticket, token) {
  const params = new URLSearchParams({
    origin: ticket.origin,
    destination: ticket.dest,
    departure_at: ticket.departure_at,
    direct: String(ticket.flight_type === 'direct'),
    currency: 'eur',
    market: marketForOrigin(ticket.origin),
    limit: '500',
    token,
  });
  if (ticket.return_at) params.set('return_at', ticket.return_at);
  return `https://api.travelpayouts.com/aviasales/v3/prices_for_dates?${params}`;
}

async function fetchExactFare(ticket, idle = null) {
  if (idle && !await idle()) return { status: 'yielded' };
  const controller = new AbortController();
  let yielded = false;
  let polling = false;
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  // A priority-0 run must yield even while an upstream request is in flight.  The cursor is not
  // advanced for this ticket, so the next genuinely idle run resumes safely from it.
  const watcher = idle ? setInterval(async () => {
    if (polling) return;
    polling = true;
    try {
      if (!await idle()) { yielded = true; controller.abort(); }
    } catch { yielded = true; controller.abort(); }
    finally { polling = false; }
  }, 2000) : null;
  try {
    const response = await fetch(buildTicketUrl(ticket, TP_TOKEN), {
      signal: controller.signal,
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) return { status: 'error', detail: `HTTP ${response.status}` };
    let body;
    try { body = await response.json(); }
    catch (error) { return { status: 'error', detail: `invalid JSON: ${error.message}` }; }
    if (body?.success !== true || !Array.isArray(body.data)) {
      return { status: 'error', detail: `unusable body${body?.error ? `: ${body.error}` : ''}` };
    }
    const fare = selectExactFare(body.data, ticket);
    if (yielded) return { status: 'yielded' };
    return fare ? { status: 'found', fare } : { status: 'unavailable' };
  } catch (error) {
    if (yielded) return { status: 'yielded' };
    return { status: 'error', detail: error.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : error.message };
  } finally {
    clearTimeout(timer);
    if (watcher) clearInterval(watcher);
  }
}

function matchOffer(query, ticket) {
  let matched = query
    .eq('origin', ticket.origin)
    .eq('dest', ticket.dest)
    .eq('month', ticket.departure_at.slice(0, 7))
    .eq('flight_type', ticket.flight_type)
    .eq('departure_at', ticket.departure_at);
  matched = ticket.return_at ? matched.eq('return_at', ticket.return_at) : matched.is('return_at', null);
  return matched;
}

async function latestPool(supabase) {
  const { data: latest, error: latestError } = await supabase
    .from('daily_origin_cheapest_pool')
    .select('snapshot_at')
    .order('snapshot_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw latestError;
  if (!latest) return [];

  const rows = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('daily_origin_cheapest_pool')
      .select('origin,dest,flight_type,departure_at,return_at,price,snapshot_at')
      .eq('snapshot_at', latest.snapshot_at)
      .order('origin').order('rank')
      .range(from, from + PAGE - 1);
    if (error) throw error;
    rows.push(...data);
    if (data.length < PAGE) break;
  }
  return [...new Map(rows.map((row) => [ticketKey(row), row])).values()];
}

async function loadCheckpoint(supabase) {
  const { data, error } = await supabase.from('roulette_price_refresh_checkpoint')
    .select('snapshot_at,cursor_key').eq('singleton', true).maybeSingle();
  if (error) throw new Error(`roulette refresh checkpoint read failed: ${error.message}`);
  return data;
}

async function saveCheckpoint(supabase, snapshotAt, cursorKey) {
  const { error } = await supabase.from('roulette_price_refresh_checkpoint').upsert({
    singleton:true, snapshot_at:snapshotAt, cursor_key:cursorKey, updated_at:new Date().toISOString(),
  }, { onConflict:'singleton' });
  if (error) throw new Error(`roulette refresh checkpoint write failed: ${error.message}`);
}

async function clearCheckpoint(supabase) {
  const { error } = await supabase.from('roulette_price_refresh_checkpoint').delete().eq('singleton', true);
  if (error) throw new Error(`roulette refresh checkpoint clear failed: ${error.message}`);
}

async function main() {
  if (!TP_TOKEN || !SUPABASE_SERVICE_KEY) throw new Error('Missing TP_TOKEN or SUPABASE_SERVICE_KEY.');
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
  const tickets = await latestPool(supabase);
  if (!tickets.length) {
    console.log('No roulette pool exists yet — targeted refresh skipped.');
    return;
  }

  const idle = process.env.GITHUB_TOKEN
    ? () => githubIsIdle({ token:process.env.GITHUB_TOKEN, repository:process.env.GITHUB_REPOSITORY,
      runId:process.env.GITHUB_RUN_ID, ownWorkflowName:ROULETTE_REFRESH_WORKFLOW })
    : null;
  // Missing/unknown GitHub state is deliberately treated as busy. Local manual execution has no
  // GITHUB_TOKEN and is explicit owner work, so it may still run without this background gate.
  if (idle && !await idle()) {
    console.log('Priority 0 roulette refresh: another workflow is queued/running or state is unknown; skipped.');
    return;
  }
  const snapshotAt = tickets[0].snapshot_at;
  const checkpoint = await loadCheckpoint(supabase);
  const checkpointIsCurrent = checkpoint?.snapshot_at === snapshotAt;
  const afterCursor = checkpointIsCurrent && checkpoint?.cursor_key
    ? tickets.findIndex((ticket) => ticketKey(ticket) === checkpoint.cursor_key) + 1
    : 0;
  const start = afterCursor > 0 ? afterCursor : 0;

  const counts = { found: 0, unavailable: 0, error: 0, changed: 0 };
  for (let index = start; index < tickets.length; index += 1) {
    const ticket = tickets[index];
    const result = await fetchExactFare(ticket, idle);
    if (result.status === 'yielded') {
      console.log(`Priority 0 roulette refresh yielded before ${ticketKey(ticket)}; checkpoint remains at ${checkpointIsCurrent ? checkpoint?.cursor_key ?? 'start' : 'start'}.`);
      return;
    }
    if (result.status === 'found') {
      const updatedAt = new Date().toISOString();
      const [patch] = withPriceProvenance([{ price: result.fare.price, transfers: result.fare.transfers, airline: result.fare.airline, updated_at: updatedAt, flight_type: ticket.flight_type, market: marketForOrigin(ticket.origin) }], 'offers');
      const { error } = await matchOffer(supabase.from('offers').update(patch), ticket);
      if (error) throw new Error(`offer update failed for ${ticketKey(ticket)}: ${error.message}`);
      counts.found += 1;
      if (Number(ticket.price) !== result.fare.price) counts.changed += 1;
    } else if (result.status === 'unavailable') {
      const { error } = await matchOffer(supabase.from('offers').delete(), ticket);
      if (error) throw new Error(`offer delete failed for ${ticketKey(ticket)}: ${error.message}`);
      counts.unavailable += 1;
    } else {
      counts.error += 1;
      console.warn(`Keeping ${ticketKey(ticket)} after inconclusive check: ${result.detail}`);
    }
    await saveCheckpoint(supabase, snapshotAt, ticketKey(ticket));
    console.log(`[${index + 1}/${tickets.length}] ${ticket.origin}→${ticket.dest} ${result.status}`);
    if (index + 1 < tickets.length) await sleep(INTERVAL_MS);
  }
  await clearCheckpoint(supabase);
  console.log(`Roulette refresh complete: ${counts.found} confirmed (${counts.changed} price changes), ${counts.unavailable} unavailable, ${counts.error} inconclusive; ${tickets.length} checked.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message || error); process.exit(1); });
}
