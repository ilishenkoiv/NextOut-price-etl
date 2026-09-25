// Per-process counter of rows/approximate bytes read from Supabase, broken down by table.
// Approximate bytes = JSON.stringify(rows).length, which is close enough to on-wire size to
// track relative egress cost without adding a real byte-counting transport layer.
const stats = new Map();

export function recordRead(table, rows) {
  const count = rows?.length ?? 0;
  const entry = stats.get(table) ?? { rows: 0, bytes: 0 };
  entry.rows += count;
  if (count) entry.bytes += JSON.stringify(rows).length;
  stats.set(table, entry);
}

export function egressSummary() {
  const tables = Object.fromEntries(stats.entries());
  let totalRows = 0, totalBytes = 0;
  for (const entry of stats.values()) { totalRows += entry.rows; totalBytes += entry.bytes; }
  return { event: 'egress_summary', tables, totalRows, totalBytes };
}

export function resetEgress() { stats.clear(); }
