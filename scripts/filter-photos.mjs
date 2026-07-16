// scripts/filter-photos.mjs — heuristic pre-filter to shrink the manual photo review.
//
// Reads photos/manifest.json and flags suspicious candidates PURELY from Pexels metadata
// (the `alt` description), so the human step only has to look at the doubtful ones. It never
// deletes anything — it writes reports + a starter selection you can accept or override.
//
// Flags (a candidate can carry several):
//   FLAG_BRAND      — brand names / signage / advertising in the description
//   FLAG_PEOPLE     — close-up people (portrait/man/woman/selfie/…)
//   FLAG_IRRELEVANT — no city, country, or place word at all (likely off-topic / empty alt)
//   FLAG_INDOOR     — interiors / close-ups / abstract / food (not a destination view)
//
// Outputs (all under photos/, all git-ignored):
//   photos/filter-report.txt   — human summary (totals, per-flag counts, all-flagged cities,
//                                clean-per-city)
//   photos/auto-selected.json  — { iata: [file,…] } up to 5 CLEAN candidates (by pexels_id)
//   photos/needs-manual.txt     — cities with < 5 clean candidates (need eyes / new query)
//   photos/flags.json          — { iata: { file: { flags:[…], reason:"…" } } } consumed by
//                                review.mjs to draw red borders on flagged photos
//
//   node scripts/filter-photos.mjs
//
// Heuristic, not truth: alt text is short and sometimes wrong. Treat the flags as HINTS —
// auto-selected.json is a starting point, review.html (with these flags drawn on) is the call.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CITIES } from '../src/data/cities.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHOTOS_DIR = path.join(__dirname, '..', 'photos');
const MANIFEST_PATH = path.join(PHOTOS_DIR, 'manifest.json');
const REPORT_PATH = path.join(PHOTOS_DIR, 'filter-report.txt');
const AUTO_PATH = path.join(PHOTOS_DIR, 'auto-selected.json');
const NEEDS_PATH = path.join(PHOTOS_DIR, 'needs-manual.txt');
const FLAGS_PATH = path.join(PHOTOS_DIR, 'flags.json');

const TARGET = 5; // photos wanted per city

// ── Keyword sets ─────────────────────────────────────────────────────────────
// Brand names + signage/advertising words. Matched as substrings (brands vary in spelling).
const BRAND_TERMS = [
  'logo', 'sign', 'signage', 'advertisement', 'advertising', 'billboard', 'store front',
  'storefront', 'shop sign', 'shopfront', 'neon sign', 'brand', 'poster',
  // common brand names that surface in street/city shots
  'coca-cola', 'coca cola', 'pepsi', 'mcdonald', "mcdonald's", 'starbucks', 'burger king',
  'kfc', 'subway sandwich', 'nike', 'adidas', 'puma', 'gucci', 'prada', 'louis vuitton',
  'chanel', 'zara', 'h&m', 'ikea', 'apple store', 'samsung', 'huawei', 'google', 'amazon',
  'shell', 'total', 'heineken', 'carlsberg', 'red bull', 'lego', 'disney',
];
// Close-up people. Word-boundary matched (so "man" won't fire on "Germany"/"Oman"/"human").
const PEOPLE_TERMS = [
  'portrait', 'man', 'woman', 'men', 'women', 'person', 'people', 'selfie', 'model',
  'girl', 'boy', 'face', 'child', 'children', 'kid', 'lady', 'guy', 'crowd of people',
];
// Interiors / abstraction / food. Word-boundary matched.
const INDOOR_TERMS = [
  'indoor', 'indoors', 'interior', 'close-up', 'closeup', 'close up', 'macro', 'texture',
  'pattern', 'abstract', 'food', 'plate', 'dish', 'meal', 'table setting', 'coffee cup',
];
// Place / geography words that make an alt plausibly about a destination. Word-boundary matched.
const GEO_TERMS = [
  'beach', 'sea', 'ocean', 'city', 'town', 'village', 'street', 'building', 'buildings',
  'mountain', 'mountains', 'hill', 'harbour', 'harbor', 'port', 'architecture', 'skyline',
  'sunset', 'sunrise', 'view', 'panorama', 'church', 'cathedral', 'mosque', 'temple',
  'castle', 'palace', 'fortress', 'bridge', 'island', 'coast', 'coastline', 'bay', 'lake',
  'river', 'square', 'old town', 'landmark', 'monument', 'tower', 'landscape', 'cityscape',
  'aerial', 'waterfront', 'promenade', 'downtown', 'ruins', 'desert', 'garden', 'park',
];

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// Substring (case-insensitive) — for brand names, whose forms vary.
const hasSub = (text, term) => text.includes(term);
// Word-boundary match — for single words / phrases where substrings would over-fire.
const hasWord = (text, term) => new RegExp(`(^|[^a-z0-9])${esc(term)}([^a-z0-9]|$)`).test(text);

// Significant tokens of a place name (>=4 chars) — so "Oia, Santorini" matches "Santorini".
function nameTokens(name) {
  return (name || '')
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((t) => t.length >= 4);
}

function classify(alt, iata) {
  const text = ` ${(alt || '').toLowerCase()} `;
  const flags = [];
  const reasons = [];

  const brand = BRAND_TERMS.filter((t) => hasSub(text, t));
  if (brand.length) { flags.push('FLAG_BRAND'); reasons.push(`brand: ${brand.join(', ')}`); }

  const people = PEOPLE_TERMS.filter((t) => hasWord(text, t));
  if (people.length) { flags.push('FLAG_PEOPLE'); reasons.push(`people: ${people.join(', ')}`); }

  const indoor = INDOOR_TERMS.filter((t) => hasWord(text, t));
  if (indoor.length) { flags.push('FLAG_INDOOR'); reasons.push(`indoor: ${indoor.join(', ')}`); }

  // Relevance: city tokens, country tokens, or any geo word present?
  const meta = CITIES[iata] || {};
  const placeTokens = [...nameTokens(meta.city), ...nameTokens(meta.country)];
  const hasPlace = placeTokens.some((t) => hasWord(text, t));
  const geo = GEO_TERMS.filter((t) => hasWord(text, t));
  if (!hasPlace && geo.length === 0) {
    flags.push('FLAG_IRRELEVANT');
    reasons.push((alt || '').trim() ? 'no city/country/place word' : 'empty description');
  }

  return { flags, reason: reasons.join(' | ') };
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const entries = Object.values(manifest).sort((a, b) => a.city.localeCompare(b.city));

  const flagCounts = { FLAG_BRAND: 0, FLAG_PEOPLE: 0, FLAG_IRRELEVANT: 0, FLAG_INDOOR: 0 };
  let totalCand = 0, totalClean = 0;
  const allFlaggedCities = [];      // every candidate flagged → bad photoQuery
  const cleanPerCity = [];          // { iata, city, total, clean }
  const autoSelected = {};
  const needsManual = [];           // { iata, city, clean }
  const flagsOut = {};              // iata → file → { flags, reason }

  for (const entry of entries) {
    const { iata, city, candidates = [] } = entry;
    const clean = [];
    let flaggedInCity = 0;

    for (const c of candidates) {
      totalCand++;
      const { flags, reason } = classify(c.alt, iata);
      if (flags.length) {
        flaggedInCity++;
        for (const f of flags) flagCounts[f]++;
        (flagsOut[iata] ||= {})[c.file] = { flags, reason };
      } else {
        clean.push(c);
      }
    }

    totalClean += clean.length;
    cleanPerCity.push({ iata, city, total: candidates.length, clean: clean.length });

    if (candidates.length > 0 && flaggedInCity === candidates.length) {
      allFlaggedCities.push({ iata, city, total: candidates.length });
    }

    // auto-selected: up to 5 clean, ordered by pexels_id ascending (stable, deterministic).
    const picks = clean
      .slice()
      .sort((a, b) => (a.pexels_id || 0) - (b.pexels_id || 0))
      .slice(0, TARGET)
      .map((c) => c.file);
    if (picks.length) autoSelected[iata] = picks;
    if (clean.length < TARGET) needsManual.push({ iata, city, clean: clean.length });
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  const L = [];
  L.push('NextOut — photo filter report');
  L.push('='.repeat(60));
  L.push(`Cities:              ${entries.length}`);
  L.push(`Candidates total:    ${totalCand}`);
  L.push(`Clean (no flags):    ${totalClean}  (${((totalClean / totalCand) * 100).toFixed(1)}%)`);
  L.push(`Flagged:             ${totalCand - totalClean}`);
  L.push('');
  L.push('Flags (a candidate may carry several):');
  for (const [f, n] of Object.entries(flagCounts)) L.push(`  ${f.padEnd(16)} ${n}`);
  L.push('');
  L.push(`Cities where ALL candidates are flagged (need a better photoQuery): ${allFlaggedCities.length}`);
  for (const c of allFlaggedCities) L.push(`  ${c.iata}  ${c.city}  (${c.total}/${c.total} flagged)`);
  L.push('');
  L.push(`Cities with < ${TARGET} clean candidates (need manual look): ${needsManual.length}`);
  for (const c of needsManual) L.push(`  ${c.iata}  ${c.city.padEnd(22)} clean: ${c.clean}/${TARGET}`);
  L.push('');
  L.push(`Cities with >= ${TARGET} clean (auto-selectable): ${entries.length - needsManual.length}`);
  L.push('');
  L.push('Clean candidates per city:');
  for (const c of cleanPerCity.slice().sort((a, b) => a.clean - b.clean)) {
    L.push(`  ${c.iata}  ${c.city.padEnd(22)} clean ${c.clean}/${c.total}`);
  }
  const report = L.join('\n') + '\n';

  await writeFile(REPORT_PATH, report);
  await writeFile(AUTO_PATH, JSON.stringify(autoSelected, null, 2));
  await writeFile(
    NEEDS_PATH,
    needsManual.map((c) => `${c.iata}\t${c.city}\tclean=${c.clean}/${TARGET}`).join('\n') + '\n',
  );
  await writeFile(FLAGS_PATH, JSON.stringify(flagsOut, null, 2));

  // Console summary (the same headline numbers, for the run).
  console.log(report.split('\nClean candidates per city:')[0]); // everything above the long list
  console.log(`✓ Wrote: filter-report.txt, auto-selected.json, needs-manual.txt, flags.json (in photos/)`);
  console.log('  Re-run review.mjs to see flags drawn on the gallery.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
