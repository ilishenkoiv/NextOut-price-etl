// Per-variant freshness timestamps for one `prices` row (§variant-timestamps, owner spec
// 2026-09-26). Pure — no I/O, no Date.now() — so callers control the exact instant and both the
// price row and its timestamps share ONE `nowIso`, kept atomic in the same upsert payload.
//
// `answered` is the flight-type Set fetch-prices.mjs already builds per route-month cell: a type
// is in it only when ITS OWN TravelPayouts attempt this run returned an ok response — priced, or a
// genuine "no fare" — never a refusal/timeout/client-error. That is exactly "genuinely observed
// this run", independent of which type's price ends up in the row (`usedType`): a variant can be
// genuinely re-confirmed empty in the SAME cycle another variant supplies the row's price.
//
// Returns only the keys that should be stamped. Omitting a key — not setting it to null — is the
// point: PostgREST's upsert only UPDATEs columns present in the payload, so a variant that was not
// answered this run (a carried-forward price, a failed/refused check, or an untouched sibling)
// keeps its previous checked_at untouched, never "freshened" by a cycle that never checked it.
export function variantCheckedAtPatch(answered, nowIso) {
  const patch = {};
  if (answered.has('direct')) patch.direct_checked_at = nowIso;
  if (answered.has('any')) patch.any_checked_at = nowIso;
  return patch;
}
