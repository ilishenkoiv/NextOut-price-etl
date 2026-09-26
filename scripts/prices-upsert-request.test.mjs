// Exercises the REAL @supabase/supabase-js + @supabase/postgrest-js request-construction path
// for `.from('prices').upsert(rows, { onConflict: 'origin,dest,month' })` — the actual call
// fetch-prices.mjs makes — with a fake `fetch` that only captures the outgoing HTTP request and
// never touches the network. This is deliberately NOT a pure-helper/regex test: it is the
// evidentiary check for the batch-upsert gap found in review (2026-09-26), and now also for the
// fare-preservation fix (same day, follow-up).
//
// THE GAP (confirmed against the installed SDK, not assumed from a comment): postgrest-js's
// upsert() builds its `columns=` URL parameter from the UNION of every row's OWN keys across the
// WHOLE array (see node_modules/@supabase/postgrest-js — `values.reduce((acc,x) =>
// acc.concat(Object.keys(x)), [])`). PostgREST then applies that column list to EVERY row; a row
// whose JSON object is missing one of those keys is written as an explicit NULL for that column —
// omitting a key does NOT mean "leave the existing value untouched" once ANY other row in the
// same flush batch happens to include it (the common case here: a 500-row batch mixes
// direct-type and any-type destinations). The fix (buildVariantPriceRow) always supplies all four
// columns (direct, any_stops, direct_checked_at, any_checked_at) explicitly on every row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@supabase/supabase-js';
import { buildVariantPriceRow } from './price-variant-timestamps.mjs';

async function captureUpsertRequest(rows) {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url: new URL(url.toString()), body: JSON.parse(init.body) };
    return new Response(JSON.stringify([]), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const supabase = createClient('https://example.supabase.co', 'fake.fake.fake', {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: fakeFetch },
  });
  await supabase.from('prices').upsert(rows, { onConflict: 'origin,dest,month' });
  return captured;
}

test('GAP DEMONSTRATED: an omission-based row shape lets one row\'s missing key null out another row\'s column in the real request', async () => {
  // Old (broken) design: only the genuinely-answered variant's key was present at all.
  const oldStyleRows = [
    { origin: 'BER', dest: 'PMI', month: '2026-11', direct: 120, any_stops: null,
      updated_at: '2026-09-26T12:00:00Z', direct_checked_at: '2026-09-26T12:00:00Z' }, // 'any_checked_at' key omitted
    { origin: 'BER', dest: 'DXB', month: '2026-11', direct: null, any_stops: 400,
      updated_at: '2026-09-26T12:00:00Z', any_checked_at: '2026-09-26T12:00:00Z' }, // 'direct_checked_at' key omitted
  ];
  const req = await captureUpsertRequest(oldStyleRows);
  const columns = req.url.searchParams.get('columns');
  assert.ok(columns.includes('"direct_checked_at"'));
  assert.ok(columns.includes('"any_checked_at"'));
  assert.ok(!('any_checked_at' in req.body[0]), 'row 1 genuinely omits any_checked_at from its own JSON');
  assert.ok(!('direct_checked_at' in req.body[1]), 'row 2 genuinely omits direct_checked_at from its own JSON');
  // No Prefer: missing=default is sent (confirmed) → PostgREST's documented default writes NULL
  // for a listed-but-absent column, per row. That is the gap.
  assert.equal(req.url.searchParams.has('columns'), true);
});

test('FIX VERIFIED, mixed batch, direct-only + any-only cells: each row supplies all four keys explicitly, both fares AND timestamps consistent', async () => {
  const nowIso = '2026-09-26T12:00:00Z';
  const rows = [
    // direct-type destination: direct answered+priced now; any-side carries its OLD baseline
    // fare+timestamp forward untouched (failed/untouched sibling).
    { origin: 'BER', dest: 'PMI', month: '2026-11', updated_at: nowIso,
      ...buildVariantPriceRow(new Set(['direct']), { direct: 120 }, nowIso,
        { direct: 99, any_stops: 300, direct_checked_at: '2026-09-10T03:00:00Z', any_checked_at: '2026-09-11T03:00:00Z' }) },
    // any-type destination: any answered+priced now; direct-side carries its OLD baseline forward.
    { origin: 'BER', dest: 'DXB', month: '2026-11', updated_at: nowIso,
      ...buildVariantPriceRow(new Set(['any']), { any: 400 }, nowIso,
        { direct: 500, any_stops: 350, direct_checked_at: '2026-09-12T03:00:00Z', any_checked_at: '2026-09-13T03:00:00Z' }) },
  ];
  const req = await captureUpsertRequest(rows);
  assert.deepEqual(req.body[0], {
    origin: 'BER', dest: 'PMI', month: '2026-11', updated_at: nowIso,
    direct: 120, direct_checked_at: nowIso, any_stops: 300, any_checked_at: '2026-09-11T03:00:00Z',
  });
  assert.deepEqual(req.body[1], {
    origin: 'BER', dest: 'DXB', month: '2026-11', updated_at: nowIso,
    direct: 500, direct_checked_at: '2026-09-12T03:00:00Z', any_stops: 400, any_checked_at: nowIso,
  });
});

test('FIX VERIFIED: confirmed no-fare on the observed variant clears ONLY that variant\'s fare, sibling stays put', async () => {
  const nowIso = '2026-09-26T12:00:00Z';
  const rows = [
    { origin: 'HAM', dest: 'ATH', month: '2026-12', updated_at: nowIso,
      ...buildVariantPriceRow(new Set(['direct']), { direct: null }, nowIso,
        { direct: 210, any_stops: 260, direct_checked_at: '2026-09-01T03:00:00Z', any_checked_at: '2026-09-02T03:00:00Z' }) },
  ];
  const req = await captureUpsertRequest(rows);
  assert.equal(req.body[0].direct, null);          // just confirmed empty
  assert.equal(req.body[0].direct_checked_at, nowIso);
  assert.equal(req.body[0].any_stops, 260);         // sibling fare untouched
  assert.equal(req.body[0].any_checked_at, '2026-09-02T03:00:00Z'); // sibling timestamp untouched
});

test('new row, no baseline: unanswered variant is explicit null fare + null timestamp, still safe in a mixed batch', async () => {
  const nowIso = '2026-09-26T12:00:00Z';
  const rows = [
    { origin: 'HAM', dest: 'JFK', month: '2026-12', updated_at: nowIso,
      ...buildVariantPriceRow(new Set(['direct']), { direct: 900 }, nowIso, undefined) },
  ];
  const req = await captureUpsertRequest(rows);
  assert.equal(req.body[0].any_stops, null);
  assert.equal(req.body[0].any_checked_at, null);
  assert.equal(req.body[0].direct, 900);
  assert.equal(req.body[0].direct_checked_at, nowIso);
});
