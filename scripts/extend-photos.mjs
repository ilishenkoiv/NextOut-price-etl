// scripts/extend-photos.mjs — APPEND new, thematically diverse candidates to cities that
// already have candidates, WITHOUT touching existing files or the user's saved selection.
//
// Why: the first TFU/PVG/FUK batches were single-theme (pandas / waterfront / food stalls).
// Deleting + refetching would have wiped the user's picks (selected.json references files by
// name). Instead this script walks every query in getPhotoQueries(iata), downloads up to
// PER_QUERY_CAP unique NEW photos per query (dedup by Pexels id against what's already in
// the manifest), and appends them as the NEXT file numbers (9.jpg, 10.jpg, …) — old files
// and old picks stay valid; the review gallery simply shows more choice.
//
//   node scripts/extend-photos.mjs TFU PVG FUK     # only these cities
//   node scripts/extend-photos.mjs                 # all cities with < MAX_TOTAL candidates
//
// Key comes from env ONLY (PEXELS_API_KEY) — this repo is PUBLIC, never hardcode it.

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getPhotoQueries } from '../src/data/cities.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHOTOS_DIR = path.join(__dirname, '..', 'photos');
const MANIFEST_PATH = path.join(PHOTOS_DIR, 'manifest.json');

const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
if (!PEXELS_API_KEY) {
  console.error('ERROR: PEXELS_API_KEY is not set — nothing was requested.');
  process.exit(1);
}

const PER_QUERY_CAP = 2;   // new candidates per query
const MAX_TOTAL = 16;      // stop extending a city at this many candidates
const PAUSE_MS = 200;      // Pexels limit is ~200 req/hour — be polite
const onlyIatas = process.argv.slice(2).map((s) => s.toUpperCase());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function searchPexels(query) {
  const url =
    'https://api.pexels.com/v1/search' +
    `?query=${encodeURIComponent(query)}` +
    `&per_page=8&orientation=landscape&size=large`;
  const res = await fetch(url, { headers: { Authorization: PEXELS_API_KEY } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for "${query}"`);
  const json = await res.json();
  return Array.isArray(json.photos) ? json.photos : [];
}

async function download(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
const nowISO = new Date().toISOString();

for (const [iata, entry] of Object.entries(manifest)) {
  if (onlyIatas.length && !onlyIatas.includes(iata)) continue;
  const existing = entry.candidates ?? [];
  if (existing.length >= MAX_TOTAL) {
    console.log(`${iata} — already has ${existing.length}, skipped`);
    continue;
  }
  const haveIds = new Set(existing.map((c) => c.pexels_id));
  const cityDir = path.join(PHOTOS_DIR, iata);
  await mkdir(cityDir, { recursive: true });
  let nextNum = existing.reduce((m, c) => Math.max(m, parseInt(c.file, 10) || 0), 0) + 1;
  const added = [];

  for (const q of getPhotoQueries(iata)) {
    if (existing.length + added.length >= MAX_TOTAL) break;
    let batch;
    try {
      batch = await searchPexels(q);
    } catch (err) {
      console.error(`${iata} — ${err.message}`);
      await sleep(PAUSE_MS);
      continue;
    }
    let addedThisQuery = 0;
    for (const p of batch) {
      if (haveIds.has(p.id) || addedThisQuery >= PER_QUERY_CAP) continue;
      if (existing.length + added.length >= MAX_TOTAL) break;
      const file = `${nextNum}.jpg`;
      const src = p.src?.large || p.src?.original || p.src?.medium;
      if (!src) continue;
      try {
        await download(src, path.join(cityDir, file));
      } catch (err) {
        console.error(`${iata} — candidate ${file} download failed: ${err.message}`);
        continue;
      }
      added.push({
        file, pexels_id: p.id, photographer: p.photographer,
        photographer_url: p.photographer_url, pexels_url: p.url,
        alt: p.alt || '', avg_color: p.avg_color || null,
        width: p.width, height: p.height, downloaded_at: nowISO, added_by: 'extend-photos',
      });
      haveIds.add(p.id);
      addedThisQuery++;
      nextNum++;
    }
    (entry.queries_tried = entry.queries_tried ?? []).includes(q) || entry.queries_tried.push(q);
    await sleep(PAUSE_MS);
  }

  if (added.length) {
    entry.candidates = [...existing, ...added];
    await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  }
  console.log(`${iata} — +${added.length} new candidates (total ${existing.length + added.length})`);
}
console.log('✓ Done. Next: filter-photos.mjs → review.mjs (saved picks are layered back automatically).');
