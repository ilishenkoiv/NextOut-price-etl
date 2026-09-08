// Lowest-priority consumer. Never writes prices/offers; only completes its leased audit record.
import { pathToFileURL } from 'node:url';
import { marketForOrigin } from '../src/data/origin-markets.js';

export const WORKFLOW_NAME = 'Flight price feedback audit · priority 0';
const ACTIVE = ['in_progress', 'queued', 'waiting', 'pending', 'requested'];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function githubIsIdle({ fetchImpl = fetch, token, repository, runId, ownWorkflowName = WORKFLOW_NAME }) {
  if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !/^\d+$/.test(runId || '')) return false;
  // Query each live status, not just the newest 100 runs. Error/denied/rate-limited = busy.
  for (const status of ACTIVE) {
    for (let page = 1; page <= 10; page++) {
      let body;
      try {
        const response = await fetchImpl(`https://api.github.com/repos/${repository}/actions/runs?status=${status}&per_page=100&page=${page}`, {
          headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' },
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok) return false;
        body = await response.json();
      } catch { return false; }
      if (!Array.isArray(body.workflow_runs)) return false;
      if (body.workflow_runs.some(r => String(r.id) !== runId && r.name !== ownWorkflowName)) return false;
      if (body.workflow_runs.length < 100) break;
      if (page === 10) return false;
    }
  }
  return true;
}

export function ticketFromFeedback(f, today = new Date().toISOString().slice(0, 10)) {
  if (!/^[A-Z]{3}$/.test(f.origin_iata || '') || !/^[A-Z]{3}$/.test(f.destination_iata || '')
    || !/^\d{4}-\d{2}-\d{2}$/.test(f.depart_date || '') || !/^\d{4}-\d{2}-\d{2}$/.test(f.return_date || '')
    || f.depart_date < today || f.return_date <= f.depart_date
    || !['direct', 'any'].includes(f.flight_type)) return null;
  return { origin: f.origin_iata, dest: f.destination_iata, depart: f.depart_date, ret: f.return_date, mode: f.flight_type };
}

export function classifyResponse(body, ticket) {
  if (body?.success !== true || !Array.isArray(body.data)) return { status: 'error', detail: 'invalid_response' };
  let best = null;
  for (const row of body.data) {
    if (!row || typeof row !== 'object') return { status: 'error', detail: 'invalid_row' };
    if (typeof row.departure_at !== 'string' || typeof row.return_at !== 'string') return { status: 'error', detail: 'invalid_dates' };
    if (row.departure_at.slice(0, 10) !== ticket.depart || row.return_at.slice(0, 10) !== ticket.ret) continue;
    if ((row.origin && row.origin !== ticket.origin) || (row.destination && row.destination !== ticket.dest)) continue;
    if (row.currency && (typeof row.currency !== 'string' || row.currency.toUpperCase() !== 'EUR')) return { status: 'error', detail: 'currency_mismatch' };
    if (typeof row.price !== 'number' || !Number.isFinite(row.price) || row.price <= 0 || row.price > 100000)
      return { status: 'error', detail: 'invalid_price' };
    if (ticket.mode === 'direct' && !Number.isInteger(row.transfers)) return { status: 'error', detail: 'unknown_stop_count' };
    if (ticket.mode === 'direct' && row.transfers !== 0) continue;
    best = best == null ? row.price : Math.min(best, row.price);
  }
  return best == null ? { status: 'no_result', detail: 'no_exact_offer_in_provider_cache' }
    : { status: 'found', price: Math.round(best), detail: 'aviasales_data_api_cached_adult_fare_eur' };
}

export async function checkTicket(ticket, { token, fetchImpl = fetch, idle }) {
  if (!await idle()) return { status: 'pending', detail: 'waiting_for_idle_github' };
  const params = new URLSearchParams({ origin: ticket.origin, destination: ticket.dest,
    departure_at: ticket.depart, return_at: ticket.ret, direct: String(ticket.mode === 'direct'),
    currency: 'eur', market: marketForOrigin(ticket.origin), limit: '500' });
  const controller = new AbortController();
  let yielded = false, polling = false;
  const timeout = setTimeout(() => controller.abort(), 8000);
  // A primary job may be queued after the initial check. Stop this low-priority request promptly.
  const watcher = setInterval(async () => {
    if (polling) return; polling = true;
    try { if (!await idle()) { yielded = true; controller.abort(); } }
    catch { yielded = true; controller.abort(); }
    finally { polling = false; }
  }, 2000);
  try {
    const response = await fetchImpl(`https://api.travelpayouts.com/aviasales/v3/prices_for_dates?${params}`, {
      headers: { Accept: 'application/json', 'X-Access-Token': token }, signal: controller.signal,
    });
    if (!response.ok) return { status: 'error', detail: `http_${response.status}` };
    const result = classifyResponse(await response.json(), ticket);
    return yielded ? { status: 'pending', detail: 'yielded_to_primary_workflow' } : result;
  } catch {
    return yielded ? { status: 'pending', detail: 'yielded_to_primary_workflow' }
      : { status: 'error', detail: 'network_timeout_or_invalid_json' };
  } finally { clearTimeout(timeout); clearInterval(watcher); }
}

export async function main(env = process.env) {
  const idle = () => githubIsIdle({ token: env.GITHUB_TOKEN, repository: env.GITHUB_REPOSITORY, runId: env.GITHUB_RUN_ID });
  if (!await idle()) { console.log('Priority 0: GitHub busy/unknown; queue unchanged.'); return; }
  if (env.AUDIT_GATE_ONLY === '1') { console.log('Priority 0: idle.'); return; }
  if (!env.TP_TOKEN || !env.SUPABASE_SERVICE_KEY) throw new Error('Required ETL secrets are missing.');
  const { createClient } = await import('@supabase/supabase-js');
  const db = createClient(env.SUPABASE_URL || 'https://xpalogebawoljlafsafs.supabase.co', env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } });
  let processed = 0;
  for (;;) {
    if (!await idle()) break;
    const { data, error } = await db.rpc('claim_flight_price_audit');
    if (error) throw new Error('Audit claim failed; verify migration and service-role grants.');
    const row = data?.[0]; if (!row) break;
    const ticket = ticketFromFeedback(row.feedback);
    const result = ticket ? await checkTicket(ticket, { token: env.TP_TOKEN, idle })
      : { status: 'not_requested', detail: 'missing_exact_dates_or_flight_type_or_past_departure' };
    const finished = await db.rpc('finish_flight_price_audit', {
      p_feedback_id: row.feedback_id, p_claim_token: row.claim_token,
      p_status: result.status, p_price: result.price ?? null,
      p_detail: result.detail, p_run_id: env.GITHUB_RUN_ID,
    });
    if (finished.error || finished.data !== true) throw new Error('Audit completion failed; lease will expire safely.');
    console.log(`Priority 0: ${result.status}`); // no user trip, ID, provider body or credential in logs
    if (result.status === 'pending') break;
    processed++;
    await pause(1100);
  }
  console.log(`Priority 0 nightly audit: ${processed} record(s) completed.`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(() => { console.error('Price audit failed; inspect safe job status and deployment prerequisites.'); process.exitCode = 1; });
