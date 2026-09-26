// Shared, safe-to-log formatting for a failed Supabase/PostgREST/Storage operation. Both
// collection-adapters.mjs's `query()` and collection-store.mjs's `rpc()` route their errors
// through this module so every DB failure — retried or not — leaves one structured line with
// enough to diagnose it, instead of the bare `(code)` a bug previously reduced every failure to.
//
// What is safe to log: PostgREST/Storage error bodies (code, message, details, hint) are
// server-generated diagnostic text about the failed operation — they never contain the request's
// own secrets (service-role key, bearer tokens, or the request URL/query string), which live in
// headers/URL the client attached, not in the response body. Never log those separately here.
export function dbErrorCode(error) {
  return String(error?.code || 'unknown');
}

export function logDbError({ op, error, status = null, attempt = 1 }) {
  console.error(JSON.stringify({
    event: 'db_error',
    op,
    code: dbErrorCode(error),
    status: status ?? null,
    message: typeof error?.message === 'string' ? error.message : null,
    details: typeof error?.details === 'string' ? error.details : null,
    hint: typeof error?.hint === 'string' ? error.hint : null,
    attempt,
  }));
}
