// Public, read-only pilot/price-freshness contract for the app (both carousel and roulette).
// See docs/PILOT-PRICE-METADATA-CONTRACT.md and migrations/20260924171200_collection_pilot_state.sql
// for the full API/RLS documentation and the owner policy this implements
// (docs/owner/TICKET-PRICE-POLICY-2026-09-24.md).
//
// This module is intentionally tiny and pure where possible: computePilotState() has no I/O and
// no dependency on the collection engine's state machine, so the app-side contract can never be
// coupled to (or broken by) MAIN/priority/checkpoint internals. publishPilotState() is the only
// I/O, and it writes exactly one row under the caller's own already-claimed lease — this module
// never claims a lease itself and is never a second writer.

// Owner-approved ceiling (docs/owner/TICKET-PRICE-POLICY-2026-09-24.md): "A price is `current`
// only when its actual price observation is at most 120 minutes old ... Collection cadence does
// not extend it. A server-declared ceiling may be stricter, never longer." This is a fixed policy
// value, not derived from PRIORITY_MARKET_SCHEDULE's cadence, and applies identically whether the
// pilot is active or the legacy always-30-minute schedule is running.
export const PRICE_FRESHNESS_APPROVED_MAX_MS = 120 * 60 * 1000;

// Pure: given the real process env and an optional stricter requested ceiling, returns exactly the
// two fields the app contract publishes. `pilot_active` reflects the ACTUAL repo Variable value at
// call time — never the mere presence of pilot code in this deployed build — so turning the
// Variable off (unset, or any value other than the literal string 'pilot') returns the legacy
// state on the very next publish, with no separate code path to keep in sync.
export function computePilotState(env = {}, { requestedFreshnessMs = PRICE_FRESHNESS_APPROVED_MAX_MS } = {}) {
  if (!Number.isFinite(requestedFreshnessMs) || requestedFreshnessMs <= 0)
    throw new Error('Invalid requested price freshness ceiling');
  return {
    pilot_active: env.PRIORITY_MARKET_SCHEDULE === 'pilot',
    // Math.min is the actual cap, enforced in code, not just by convention: a future stricter
    // override may lower this, nothing may ever raise it past the owner-approved ceiling.
    price_freshness_ms: Math.min(requestedFreshnessMs, PRICE_FRESHNESS_APPROVED_MAX_MS),
  };
}

// Upserts the single global row. Must be called only after the caller already holds the
// collection lease for this session (run-collection.mjs) — this function does not check or renew
// the lease itself; it relies on the caller's existing single-writer guarantee, exactly like every
// other coordinator write in this repo.
export async function publishPilotState(db, env, { clock = Date.now, requestedFreshnessMs } = {}) {
  const state = computePilotState(env, { requestedFreshnessMs });
  const { error } = await db.from('collection_pilot_state').upsert(
    { scope: 'global', ...state, updated_at: new Date(clock()).toISOString() },
    { onConflict: 'scope' },
  );
  if (error) throw new Error(`Failed to publish pilot state: ${error.message}`);
  return state;
}
