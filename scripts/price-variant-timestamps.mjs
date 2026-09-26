// Per-variant fare + freshness for one `prices` row (§variant-timestamps /
// §fare-preservation, owner spec 2026-09-26). Pure — no I/O, no Date.now() — so callers control
// the exact instant and every column of the row shares ONE `nowIso`/`prev`, kept atomic and
// consistent in the same upsert payload.
//
// `answered` is the flight-type Set fetch-prices.mjs already builds per route-month cell: a type
// is in it only when ITS OWN TravelPayouts attempt this run returned an ok response — priced, or a
// genuine "no fare" — never a refusal/timeout/client-error. `variantPrice` carries that same
// type's OWN observed price (a number, or null for a genuine confirmed no-fare) — set only for a
// type in `answered`. Both are independent of `usedType`/`res.min` (which attempt's OFFERS
// populate the offers table for this cell): a sibling type can be genuinely re-confirmed empty in
// the SAME cycle the other type supplies the cell's offers.
//
// Contract, per column pair (direct/direct_checked_at, any_stops/any_checked_at):
//   answered this cycle     → fare = variantPrice[type] (a number, or null = confirmed no-fare
//                              observed just now), checked_at = nowIso.
//   NOT answered this cycle → fare = prev's own fare, checked_at = prev's own checked_at, BOTH
//                              carried forward unchanged — never cleared, never freshened.
//   no prev row at all      → fare = null, checked_at = null (a genuinely new, never-checked
//                              variant on a brand-new row).
//
// Always returns ALL FOUR keys explicitly (never omits one). postgrest-js's array upsert builds
// its `columns=` URL parameter from the UNION of every row's own keys across the WHOLE batch (a
// 500-row flush routinely mixes direct-type and any-type destinations) — a column present in that
// union but missing from one row's JSON is written as an explicit NULL for that row by PostgREST's
// default (no `Prefer: missing=default` is sent here). Omitting a key is therefore never safe;
// every row must supply an explicit, correct value for every column every time (verified against
// the installed SDK in prices-upsert-request.test.mjs).
export function buildVariantPriceRow(answered, variantPrice, nowIso, prev) {
  const row = {};
  if (answered.has('direct')) {
    row.direct = variantPrice.direct ?? null;
    row.direct_checked_at = nowIso;
  } else {
    row.direct = prev?.direct ?? null;
    row.direct_checked_at = prev?.direct_checked_at ?? null;
  }
  if (answered.has('any')) {
    row.any_stops = variantPrice.any ?? null;
    row.any_checked_at = nowIso;
  } else {
    row.any_stops = prev?.any_stops ?? null;
    row.any_checked_at = prev?.any_checked_at ?? null;
  }
  return row;
}
