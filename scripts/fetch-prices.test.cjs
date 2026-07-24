// scripts/fetch-prices.test.cjs — static invariant over scripts/fetch-prices.mjs.
//
// THE RULE: a row may enter a Supabase write buffer ONLY on the success path of the request
// that produced it. fetchFlightMonth() returns { ok: false, min: null, offers: [] } for a
// timeout, a non-2xx (429 included) or a malformed body. Pushing THAT into priceBuf upserts
// NULL over a real price — and price_history does not record the loss either (its hasPrice
// check is false for an all-null row), so a destroyed price leaves no trace in the database
// and no line in the run log. It was a live bug: every route-month was pushed unconditionally,
// and only the fact that Travelpayouts never actually returned an error kept it from firing.
// This test fails if that shape ever comes back.
//
// STATIC ON PURPOSE. Importing fetch-prices.mjs would require TP_TOKEN + SUPABASE_SERVICE_KEY
// and start a multi-hour run against the live API, so we assert on the SHAPE of the source
// instead. Block scope is derived from indentation — the file is uniformly 2-space indented,
// and a real parser is not worth a dependency for one lint. Note the failure direction: if the
// formatting ever changes, this test gets STRICTER (reports a guarded push as unguarded),
// never looser. A false alarm is cheap; a missed null-clobber is not.
//
// RUNNER: node:test, built into Node 22+ (`npm test` → `node --test`). NOT jest — 292 packages
// and a high-severity advisory for nine static string checks in a public repo is a bad trade.
// .cjs so it stays CommonJS under this package's "type": "module".

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join, relative } = require('node:path');

const SRC_PATH = join(__dirname, 'fetch-prices.mjs');
const SRC = readFileSync(SRC_PATH, 'utf8');
const REL = relative(process.cwd(), SRC_PATH).replace(/\\/g, '/');
const LINES = SRC.split(/\r?\n/);

// Buffers whose contents reach Supabase (or the teed Storage snapshot). ADD A BUFFER HERE
// when one is added to the collector: a buffer missing from this list is invisible to the
// test, and that is the only way the invariant can quietly stop being enforced.
const WRITE_BUFFERS = ['priceBuf', 'historyBuf', 'offerBuf', 'snapshotRows'];

// A block header counts as a guard when it tests that the response arrived — `ok` from
// fetchFlightMonth, or `hasPrice`, which can only be true when a price actually came back.
// A NEGATED test (`if (!ok)`) is deliberately NOT a guard: that block is the failure path.
const TESTS_SUCCESS = /\bif\s*\([^)]*\b(?:ok|hasPrice)\b/;
const TESTS_FAILURE = /\bif\s*\([^)]*!\s*(?:ok|hasPrice)\b/;
const isGuard = (header) => TESTS_SUCCESS.test(header) && !TESTS_FAILURE.test(header);

const stripComment = (line) => line.replace(/\/\/.*$/, '');
const indentOf = (line) => line.match(/^[ ]*/)[0].length;
const isCommentLine = (line) => /^\s*(\/\/|\/\*|\*)/.test(line);

// Headers of every block enclosing `index` (0-based line), innermost first. A line indented
// less than us and ending in `{` is the block we sit in; we then look for that line's own
// enclosing block, and so on out to column 0.
function enclosingHeaders(index) {
  const headers = [];
  let indent = indentOf(LINES[index]);
  for (let i = index - 1; i >= 0 && indent > 0; i -= 1) {
    const line = LINES[i];
    if (!line.trim() || isCommentLine(line)) continue;
    const ind = indentOf(line);
    if (ind < indent && /\{\s*$/.test(stripComment(line))) {
      headers.push(line.trim());
      indent = ind;
    }
  }
  return headers;
}

// Every line that pushes into a tracked write buffer.
function pushSites() {
  const sites = [];
  LINES.forEach((line, i) => {
    const code = stripComment(line);
    for (const buf of WRITE_BUFFERS) {
      if (new RegExp(`\\b${buf}\\.push\\s*\\(`).test(code)) {
        sites.push({ buf, index: i, lineNo: i + 1, text: line.trim() });
      }
    }
  });
  return sites;
}

describe('fetch-prices.mjs — a failed Travelpayouts request must write nothing', () => {
  // The contract the guards below lean on. If the success flag is ever renamed, this fails
  // first and says why, instead of leaving the guard checks to fail cryptically.
  it('fetchFlightMonth still signals failure with ok:false', () => {
    assert.match(SRC, /return\s*\{\s*ok:\s*false/);
  });

  // Self-check: if a buffer is renamed, pushSites() returns nothing for it and the real
  // assertion below would pass vacuously. Fail loudly instead.
  for (const buf of WRITE_BUFFERS) {
    it(`${buf} is still pushed somewhere (keeps this test honest)`, () => {
      const count = pushSites().filter((s) => s.buf === buf).length;
      assert.ok(count > 0, `no \`${buf}.push(\` found in ${REL} — was the buffer renamed?`);
    });
  }

  for (const buf of WRITE_BUFFERS) {
    it(`${buf} is only pushed under a success guard`, () => {
      const unguarded = pushSites()
        .filter((s) => s.buf === buf)
        .filter((s) => !enclosingHeaders(s.index).some(isGuard))
        .map((s) => `${REL}:${s.lineNo}  ${s.text}`);

      // Non-empty means a row can be written from a request that never succeeded — the null
      // over a real price. Wrap the push in `if (ok) { … }` rather than relaxing this test.
      assert.deepEqual(unguarded, []);
    });
  }
});
