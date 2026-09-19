// scripts/fetch-photos-batch.mjs — STEP 1 (variant) of the destination-photo pipeline for the
// 48-batch expansion. Unlike fetch-photos.mjs (which derives targets from src/data/*), this
// adapter takes an EXPLICIT manifest so photo prep does not depend on catalogue readiness and
// can address shared-airport resource keys (place:zurich / place:geneva) that the IATA-only
// collector cannot.
//
// It REUSES the proven fetch-photos.mjs behaviour (pool up to 8 candidates across queries, cap
// per query, full provenance, resume) — only the target SOURCE and the OUTPUT layout differ.
//
// Side effects: writes ONLY under photos-batch/<run>/ . Never deletes, never writes to another
// run folder, never touches DB/Storage/git. The app never calls Pexels at runtime.
//
//   PowerShell:  $env:PEXELS_API_KEY="..."; node scripts/fetch-photos-batch.mjs --manifest=docs/owner/photo-expansion-w3/batch-manifest.json
//   one place:   ... --manifest=... --only=MAD,place:zurich
//   fixed run id:... --manifest=... --run=2026-09-18T00-00-00
//
// Output (per run):
//   photos-batch/<run>/<safeName>/{1..8}.jpg   — candidate images (safeName: MAD, place-zurich…)
//   photos-batch/<run>/manifest.json           — { run, generatedAt, entries: { [key]: {...} } }
//   photos-batch/<run>/problem-keys.txt        — keys with < MIN_RESULTS candidates
//   photos-batch/<run>/review.html             — concrete candidate gallery for owner selection

import { mkdir, writeFile, readFile, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PER_PAGE = 8;        // candidates kept per place
export const MIN_RESULTS = 5;     // fewer than this → flagged
export const PER_QUERY_CAP = 2;   // max unique photos taken from one query before moving on
export const PAUSE_MS = 200;      // politeness between Pexels requests (live only)

// ── Key / path safety ─────────────────────────────────────────────────────────
const IATA_RE = /^[A-Z]{3}$/;
const PLACE_RE = /^place:[a-z][a-z0-9]*$/; // e.g. place:zurich, place:geneva

// A resource key is EITHER a 3-letter IATA or a place:<id> token. Nothing else is allowed so a
// malicious/typo key can never become a path segment with separators or traversal.
export function validateKey(key) {
  if (typeof key !== 'string' || (!IATA_RE.test(key) && !PLACE_RE.test(key)))
    throw new Error(`Invalid resource key: ${JSON.stringify(key)} (want IATA like MAD or place:<id> like place:zurich)`);
  return key;
}

// Map the LOGICAL resource key to a SAFE folder name. Logical key keeps the ':' (place:zurich);
// the folder replaces it (place-zurich). Result is guaranteed [A-Za-z0-9-] only.
export function safeFolderName(key) {
  validateKey(key);
  const name = key.replace(/:/g, '-');
  if (!/^[A-Za-z0-9-]+$/.test(name) || name.includes('..'))
    throw new Error(`Unsafe folder name derived from key: ${key}`);
  return name;
}

// Resolve `name` under `base` and refuse anything that escapes the base directory.
export function resolveWithinBase(base, name) {
  const root = path.resolve(base);
  const p = path.resolve(root, name);
  if (p !== root && !p.startsWith(root + path.sep))
    throw new Error(`Path escapes output directory: ${name}`);
  return p;
}

// ── Manifest ───────────────────────────────────────────────────────────────────
// Each entry: { destinationId, key, place, queries: [primary, ...fallbacks] }
export function parseManifest(raw) {
  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;
  const entries = Array.isArray(data) ? data : data?.entries;
  if (!Array.isArray(entries) || entries.length === 0)
    throw new Error('Manifest must be a non-empty array (or { entries: [...] })');
  const seenKeys = new Set();
  const seenFolders = new Set();
  const out = [];
  for (const e of entries) {
    if (!e || typeof e !== 'object') throw new Error('Manifest entry must be an object');
    const { destinationId, key, place } = e;
    if (!destinationId || typeof destinationId !== 'string') throw new Error(`Entry missing destinationId: ${JSON.stringify(e)}`);
    validateKey(key);
    if (!place || typeof place !== 'string') throw new Error(`Entry ${key} missing place`);
    const queries = Array.isArray(e.queries) ? e.queries.filter((q) => typeof q === 'string' && q.trim()) : [];
    if (!queries.length) throw new Error(`Entry ${key} needs at least one query`);
    if (seenKeys.has(key)) throw new Error(`Duplicate resource key in manifest: ${key}`);
    const folder = safeFolderName(key);
    if (seenFolders.has(folder)) throw new Error(`Folder-name collision for key ${key} (${folder})`);
    seenKeys.add(key); seenFolders.add(folder);
    out.push({ destinationId, key, place, folder, queries });
  }
  return out;
}

// ── Live Pexels adapter (overridable in tests via deps) ─────────────────────────
async function livePexelsSearch(query, apiKey) {
  const url = 'https://api.pexels.com/v1/search'
    + `?query=${encodeURIComponent(query)}&per_page=${PER_PAGE}&orientation=landscape&size=large`;
  const res = await fetch(url, { headers: { Authorization: apiKey } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`);
  }
  const json = await res.json();
  return Array.isArray(json.photos) ? json.photos : [];
}

async function liveDownload(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download HTTP ${res.status} for ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

const exists = (p) => access(p).then(() => true).catch(() => false);
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Core: fetch candidates for one manifest, into one run folder ─────────────────
// deps = { search(query, apiKey), download(url, dest), sleep(ms), now() } — injected in tests.
export async function fetchBatch({ manifest, apiKey, outBase, runId, only = null, deps = {}, log = () => {} }) {
  const entries = parseManifest(manifest);
  const search = deps.search || ((q) => livePexelsSearch(q, apiKey));
  const download = deps.download || liveDownload;
  const sleep = deps.sleep || defaultSleep;
  const now = deps.now || (() => new Date().toISOString());
  if (!deps.search && !apiKey) throw new Error('PEXELS_API_KEY is required for live fetch');

  const run = runId || now().replace(/[:.]/g, '-');
  const runDir = resolveWithinBase(outBase, run);
  await mkdir(runDir, { recursive: true });
  const manifestPath = path.join(runDir, 'manifest.json');

  // Resume WITHIN this run only: load existing per-run manifest if present.
  let runManifest = { run, generatedAt: now(), entries: {} };
  try { runManifest = JSON.parse(await readFile(manifestPath, 'utf8')); } catch { /* fresh run */ }
  runManifest.entries = runManifest.entries || {};

  const onlySet = only ? new Set(only) : null;
  const problems = [];
  for (const entry of entries) {
    if (onlySet && !onlySet.has(entry.key)) continue;
    const cityDir = resolveWithinBase(runDir, entry.folder);

    // Resume: a key already fetched in THIS run keeps its results, no re-spend.
    if (runManifest.entries[entry.key]?.candidates?.length && (await exists(cityDir))) {
      log(`${entry.key} — already have ${runManifest.entries[entry.key].candidates.length}, skipped`);
      continue;
    }

    const photosById = new Map();
    const queriesTried = [];
    const searchErrors = [];
    for (const q of entry.queries) {
      let batch;
      try { batch = await search(q, apiKey); }
      catch (err) { searchErrors.push(`"${q}": ${err.message}`); await sleep(PAUSE_MS); continue; }
      queriesTried.push(q);
      let added = 0;
      for (const p of batch) {
        if (photosById.has(p.id) || added >= PER_QUERY_CAP) continue;
        photosById.set(p.id, { ...p, _query: q });
        added++;
      }
      await sleep(PAUSE_MS);
      if (photosById.size >= PER_PAGE) break;
    }
    const photos = [...photosById.values()].slice(0, PER_PAGE);
    if (!photos.length) {
      const why = searchErrors.length ? `search error: ${searchErrors.join(' | ')}` : 'no results';
      log(`${entry.key} — 0 candidates (${why})`);
      problems.push(`${entry.key}\t${entry.place}\t(${why})`);
      continue;
    }

    await mkdir(cityDir, { recursive: true });
    const candidates = [];
    for (let k = 0; k < photos.length; k++) {
      const p = photos[k];
      const file = `${k + 1}.jpg`;
      const src = p.src?.large || p.src?.original || p.src?.medium;
      if (!src) continue;
      try { await download(src, path.join(cityDir, file)); }
      catch (err) { log(`${entry.key} — candidate ${file} download failed: ${err.message}`); continue; }
      candidates.push({
        file, path: `${entry.folder}/${file}`,
        pexels_id: p.id,
        photographer: p.photographer,
        photographer_url: p.photographer_url,
        pexels_url: p.url,
        alt: p.alt || '',
        avg_color: p.avg_color || null,
        width: p.width, height: p.height,
        query: p._query,
        downloaded_at: now(),
      });
    }

    runManifest.entries[entry.key] = {
      destinationId: entry.destinationId, key: entry.key, place: entry.place,
      folder: entry.folder, query: queriesTried[0], queries_tried: queriesTried, candidates,
    };
    await writeFile(manifestPath, JSON.stringify(runManifest, null, 2));
    const flag = candidates.length < MIN_RESULTS ? '  ⚠ under-filled' : '';
    log(`${entry.key} — ${candidates.length} candidates${flag}`);
    if (candidates.length < MIN_RESULTS) problems.push(`${entry.key}\t${entry.place}\t(${candidates.length} results)`);
  }

  if (problems.length) await writeFile(path.join(runDir, 'problem-keys.txt'), problems.join('\n') + '\n');
  await writeFile(path.join(runDir, 'review.html'), renderReview(runManifest));
  await writeFile(manifestPath, JSON.stringify(runManifest, null, 2));
  return { runDir, runManifest, problems };
}

// ── Concrete-candidate review page (embeds the downloaded images) ────────────────
export function renderReview(runManifest) {
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const blocks = Object.values(runManifest.entries || {}).map((e) => {
    const imgs = (e.candidates || []).map((c) => `
      <figure>
        <img src="${esc(c.path)}" alt="${esc(c.alt)}" loading="lazy">
        <figcaption>#${esc(c.pexels_id)} · <a href="${esc(c.pexels_url)}" target="_blank" rel="noopener">Pexels</a> ·
          <a href="${esc(c.photographer_url)}" target="_blank" rel="noopener">${esc(c.photographer)}</a><br>
          <span class="q">${esc(c.query)}</span></figcaption>
      </figure>`).join('');
    return `<section><h2>${esc(e.destinationId)} <code>${esc(e.key)}</code> — ${esc(e.place)}
      <span class="n">${(e.candidates || []).length} candidates</span></h2>
      <div class="grid">${imgs || '<p class="warn">no candidates</p>'}</div></section>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Photo candidates — run ${esc(runManifest.run)}</title>
<style>body{font:15px system-ui,sans-serif;margin:0;background:#f6f7fb;color:#26324d}
h1{padding:16px}section{margin:0 16px 24px}h2{font-size:15px;border-bottom:1px solid #ddd;padding-bottom:6px}
h2 code{background:#eef;padding:1px 6px;border-radius:5px}.n{color:#888;font-weight:400;font-size:13px;margin-left:8px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;margin-top:10px}
figure{margin:0;background:#fff;border:1px solid #e3e7f0;border-radius:10px;overflow:hidden}
img{width:100%;height:150px;object-fit:cover;display:block}
figcaption{font-size:12px;color:#6b7690;padding:6px 8px}.q{color:#999}.warn{color:#b04a2f}</style></head>
<body><h1>Photo candidates — run ${esc(runManifest.run)}</h1>
<p style="padding:0 16px;color:#6b7690">Concrete downloaded candidates for owner selection. Nothing is approved or uploaded. Provenance (Pexels ID, photographer, source URL, query) is recorded per image in manifest.json.</p>
${blocks}
</body></html>`;
}

// ── CLI ──────────────────────────────────────────────────────────────────────
function arg(name) {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : null;
}

async function main() {
  const manifestArg = arg('manifest');
  if (!manifestArg) { console.error('ERROR: --manifest=<path.json> is required'); process.exit(1); }
  const apiKey = process.env.PEXELS_API_KEY;
  if (!apiKey) { console.error('ERROR: PEXELS_API_KEY is not set — nothing was requested.'); process.exit(1); }
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const outBase = arg('out') || path.join(__dirname, '..', 'photos-batch');
  const onlyArg = arg('only');
  const only = onlyArg ? onlyArg.split(',').map((s) => s.trim()).filter(Boolean) : null;
  const raw = await readFile(path.resolve(manifestArg), 'utf8');
  const { runDir, problems } = await fetchBatch({
    manifest: raw, apiKey, outBase, runId: arg('run'), only, log: (m) => console.log(m),
  });
  console.log(`\n✓ Run folder: ${runDir}`);
  if (problems.length) console.log(`⚠ ${problems.length} key(s) under-filled — see problem-keys.txt`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('fetch-photos-batch.mjs')) {
  main().catch((err) => { console.error('FATAL:', err); process.exit(1); });
}
