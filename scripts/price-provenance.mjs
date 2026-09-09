// No secrets or per-user data. The job process start is distinct from the workflow run start.
const startedAt = new Date().toISOString();
export function withPriceProvenance(rows, table, env = process.env, now = new Date().toISOString()) {
  return rows.map(row => ({ ...row, price_source: {
    ...(row.price_source ?? {}),
    table, run_id: /^\d+$/.test(env.GITHUB_RUN_ID || '') ? env.GITHUB_RUN_ID : null,
    run_attempt: Number(env.GITHUB_RUN_ATTEMPT) || null,
    workflow: env.GITHUB_WORKFLOW || null, job: env.GITHUB_JOB || null,
    started_at: startedAt, observed_at: row.updated_at || now,
    ...(row.flight_type ? { flight_type: row.flight_type } : {}),
    ...(row.market ? { market: row.market } : {}),
    quote_kind: table === 'prices' ? 'month_min' : 'exact',
  }}));
}
