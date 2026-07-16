// scripts/fetch-photos.mjs — STEP 1 of the one-off destination-photo pipeline.
//
// Downloads up to 8 candidate photos per destination from Pexels into photos/{IATA}/, and
// records FULL provenance for every candidate in photos/manifest.json. This is a curated,
// run-ONCE data task — the app never calls Pexels at runtime (the key would leak, the quota
// would run out, and quality would be unpredictable). Photos are picked once (step 2) and
// live in our own Supabase Storage (steps 3–4).
//
// LEGAL / provenance: the Pexels License allows commercial use and attribution is a "please"
// (not a hard "must") on normal API access. BUT Pexels gives $0 indemnification and does not
// verify uploader rights — if someone uploaded a photo they didn't own, the claim lands on
// US. So we keep the COMPLETE provenance of every candidate (photographer, source URLs, ids)
// and show attribution in the app — a good-faith paper trail, not an optional nicety.
//
//   PowerShell:  $env:PEXELS_API_KEY="..."; node scripts/fetch-photos.mjs
//   bash:        PEXELS_API_KEY=... node scripts/fetch-photos.mjs
//
// The key comes from env ONLY — this repo is PUBLIC, never hardcode it.
//
// Output:
//   photos/{IATA}/{1..8}.jpg     — candidate images
//   photos/manifest.json         — { [iata]: { iata, city, query, candidates: [ {...} ] } }
//   photos/problem-cities.txt    — cities that returned < 5 results (pick these by hand)
//
// Re-runnable: a city that already has its candidates + manifest entry is skipped, so an
// interrupted run resumes without re-spending quota. Delete photos/{IATA}/ to refetch one.

import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { DESTINATIONS } from '../src/data/destinations.js';
import { CITIES, getPhotoQueries } from '../src/data/cities.js';

// ── Config / secrets (env only) ──────────────────────────────────────────────
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
if (!PEXELS_API_KEY) {
  console.error('ERROR: PEXELS_API_KEY is not set — nothing was requested.');
  console.error('  PowerShell:  $env:PEXELS_API_KEY="..."; node scripts/fetch-photos.mjs');
  console.error('  bash:        PEXELS_API_KEY=... node scripts/fetch-photos.mjs');
  process.exit(1);
}

const PER_PAGE = 8;          // candidates fetched per city (we keep up to 8, pick 5 later)
const MIN_RESULTS = 5;       // fewer than this → flagged in problem-cities.txt
const PAUSE_MS = 200;        // Pexels limit is ~200 req/hour — be polite between requests

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHOTOS_DIR = path.join(__dirname, '..', 'photos');
const MANIFEST_PATH = path.join(PHOTOS_DIR, 'manifest.json');
const PROBLEMS_PATH = path.join(PHOTOS_DIR, 'problem-cities.txt');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const exists = (p) => access(p).then(() => true).catch(() => false);

// Load an existing manifest so re-runs resume instead of restarting.
async function loadManifest() {
  try {
    return JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  } catch {
    return {};
  }
}

// One Pexels search. Returns the raw `photos` array (may be empty). Throws on HTTP error so
// the caller can log which city failed without silently recording zero candidates.
async function searchPexels(query) {
  const url =
    'https://api.pexels.com/v1/search' +
    `?query=${encodeURIComponent(query)}` +
    `&per_page=${PER_PAGE}&orientation=landscape&size=large`;
  const res = await fetch(url, { headers: { Authorization: PEXELS_API_KEY } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  const json = await res.json();
  return Array.isArray(json.photos) ? json.photos : [];
}

// Download one image URL to disk (streamed, no full buffer in memory).
async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

async function main() {
  await mkdir(PHOTOS_DIR, { recursive: true });
  const manifest = await loadManifest();
  const problems = [];
  const nowISO = new Date().toISOString();

  const total = DESTINATIONS.length;
  for (let i = 0; i < total; i++) {
    const { iata } = DESTINATIONS[i];
    const meta = CITIES[iata];
    const n = `[${i + 1}/${total}]`;

    if (!meta) {
      console.warn(`${n} ${iata} — no city mapping in cities.js, SKIPPED`);
      problems.push(`${iata}\t(no city mapping)`);
      continue;
    }
    const { city } = meta;
    const queries = getPhotoQueries(iata); // [primary, ...photoQueryFallbacks]

    // Resume: skip cities already fetched (candidates on disk + manifest entry).
    const cityDir = path.join(PHOTOS_DIR, iata);
    if (manifest[iata]?.candidates?.length && (await exists(cityDir))) {
      console.log(`${n} ${city} — already have ${manifest[iata].candidates.length}, skipped`);
      continue;
    }

    // Try the primary query; if the city comes up short (< MIN_RESULTS), try the next
    // fallback query, MERGING unique photos (dedup by Pexels id) until we have enough or run
    // out of queries. Each query is one API request, so pause after every one.
    const photosById = new Map();
    const queriesTried = [];
    const searchErrors = [];
    for (const q of queries) {
      let batch;
      try {
        batch = await searchPexels(q);
      } catch (err) {
        searchErrors.push(`"${q}": ${err.message}`);
        await sleep(PAUSE_MS);
        continue;
      }
      queriesTried.push(q);
      for (const p of batch) if (!photosById.has(p.id)) photosById.set(p.id, p);
      await sleep(PAUSE_MS);
      if (photosById.size >= MIN_RESULTS) break; // enough — don't spend fallback requests
    }
    const photos = [...photosById.values()].slice(0, PER_PAGE);

    if (!photos.length) {
      const why = searchErrors.length ? `search error: ${searchErrors.join(' | ')}` : 'no results';
      console.error(`${n} ${city} — 0 candidates (${why})`);
      problems.push(`${iata}\t${city}\t(${why})`);
      continue;
    }

    await mkdir(cityDir, { recursive: true });
    const candidates = [];
    for (let k = 0; k < photos.length; k++) {
      const p = photos[k];
      const file = `${k + 1}.jpg`;
      // `large` is the ~1200px-wide variant — plenty for review and later optimization.
      const src = p.src?.large || p.src?.original || p.src?.medium;
      if (!src) continue;
      try {
        await download(src, path.join(cityDir, file));
      } catch (err) {
        console.error(`${n} ${city} — candidate ${file} download failed: ${err.message}`);
        continue;
      }
      candidates.push({
        file,                                    // photos/{IATA}/{file}
        pexels_id: p.id,
        photographer: p.photographer,
        photographer_url: p.photographer_url,
        pexels_url: p.url,                        // the photo's page on pexels.com (attribution)
        alt: p.alt || '',
        avg_color: p.avg_color || null,
        width: p.width,
        height: p.height,
        downloaded_at: nowISO,
      });
    }

    manifest[iata] = { iata, city, query: queriesTried[0], queries_tried: queriesTried, candidates };
    // Persist after every city so an interrupted run keeps what it already fetched.
    await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

    const viaNote = queriesTried.length > 1 ? `  (via: ${queriesTried.join(' → ')})` : '';
    const flag = candidates.length < MIN_RESULTS ? '  ⚠ under-filled' : '';
    console.log(`${n} ${city} — ${candidates.length} candidates${flag}${viaNote}`);
    if (candidates.length < MIN_RESULTS) {
      problems.push(`${iata}\t${city}\t(${candidates.length} results, tried: ${queriesTried.join(' | ')})`);
    }
  }

  if (problems.length) {
    await writeFile(PROBLEMS_PATH, problems.join('\n') + '\n');
    console.log(`\n⚠ ${problems.length} city(ies) need a manual look — see photos/problem-cities.txt`);
  } else {
    console.log('\n✓ Every city returned enough candidates.');
  }
  console.log(`✓ Manifest: ${path.relative(process.cwd(), MANIFEST_PATH)}`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
