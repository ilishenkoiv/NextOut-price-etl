// scripts/review.mjs — STEP 2 of the photo pipeline (generates the MANUAL selection UI).
//
// Reads photos/manifest.json and writes photos/review.html — a static gallery, grouped by
// city, with a large preview + photographer credit + checkbox on every candidate. YOU open
// it in a browser and pick the best 5 per city. Click ORDER matters: the first photo you
// click becomes the hero (position 1). "Save selection" downloads photos/selected.json:
//
//     { "SPU": ["1.jpg", "4.jpg", "2.jpg", "7.jpg", "5.jpg"], ... }   // order = position
//
// No server, no build step, no dependencies — just open the file. Images are referenced by
// relative path ({IATA}/{file}), so keep review.html inside photos/ next to the folders.
//
//   node scripts/review.mjs      → writes photos/review.html
//   then open photos/review.html in a browser.

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHOTOS_DIR = path.join(__dirname, '..', 'photos');
const MANIFEST_PATH = path.join(PHOTOS_DIR, 'manifest.json');
const FLAGS_PATH = path.join(PHOTOS_DIR, 'flags.json');
const AUTO_PATH = path.join(PHOTOS_DIR, 'auto-selected.json');
const SELECTED_PATH = path.join(PHOTOS_DIR, 'selected.json');
const OUT_PATH = path.join(PHOTOS_DIR, 'review.html');

async function loadJson(p) {
  try {
    return JSON.parse(await readFile(p, 'utf8'));
  } catch {
    return {};
  }
}
// flags.json         → red borders + reasons on suspect photos (from filter-photos.mjs).
// Pre-load priority for the gallery selection:
//   auto-selected.json = base layer (heuristic picks for every city)
//   selected.json      = YOUR saved manual picks, layered ON TOP (per-city override)
// So regenerating review.html never drops a city you already curated; only cities you have
// not saved yet fall back to the auto picks.

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

function cityBlock(entry, flagsForCity = {}) {
  const { iata, city, query, candidates = [] } = entry;
  const cards = candidates
    .map((c) => {
      const credit = c.photographer
        ? `<a href="${esc(c.photographer_url)}" target="_blank" rel="noopener">${esc(c.photographer)}</a> · <a href="${esc(c.pexels_url)}" target="_blank" rel="noopener">Pexels</a>`
        : `<a href="${esc(c.pexels_url)}" target="_blank" rel="noopener">Pexels</a>`;
      const fl = flagsForCity[c.file];
      const flagCls = fl ? ' flagged' : '';
      const flagBanner = fl
        ? `<div class="flag" title="${esc(fl.reason)}">⚠ ${esc(fl.flags.map((f) => f.replace('FLAG_', '')).join(' · '))}</div>`
        : '';
      return `
      <label class="cand${flagCls}" data-iata="${esc(iata)}" data-file="${esc(c.file)}"${fl ? ' data-flagged="1"' : ''}>
        <span class="badge"></span>
        ${flagBanner}
        <img loading="lazy" src="${esc(iata)}/${esc(c.file)}" alt="${esc(c.alt)}">
        <input type="checkbox" class="pick">
        <div class="credit">${credit}</div>
      </label>`;
    })
    .join('');
  return `
  <section class="city" data-iata="${esc(iata)}">
    <h2><span class="iata">${esc(iata)}</span> ${esc(city)}
      <span class="count" data-iata="${esc(iata)}">0 / 5</span>
      <span class="q">query: ${esc(query)}</span>
    </h2>
    <div class="grid">${cards}</div>
  </section>`;
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const flags = await loadJson(FLAGS_PATH);
  const auto = await loadJson(AUTO_PATH);
  const selectedSaved = await loadJson(SELECTED_PATH);
  // Manual picks win per-city; auto fills the rest.
  const preload = { ...auto, ...selectedSaved };
  const savedCities = Object.keys(selectedSaved).length;
  const autoOnly = Object.keys(preload).length - savedCities;
  const flaggedCount = Object.values(flags).reduce((n, city) => n + Object.keys(city).length, 0);
  const entries = Object.values(manifest).sort((a, b) => a.city.localeCompare(b.city));
  const totalCities = entries.length;
  const blocks = entries.map((e) => cityBlock(e, flags[e.iata] || {})).join('\n');

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>NextOut — photo review (${totalCities} cities)</title>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.4 -apple-system, Segoe UI, Roboto, sans-serif;
         background: #14151a; color: #e9eaee; }
  header { position: sticky; top: 0; z-index: 20; padding: 14px 20px;
           background: #14151aee; backdrop-filter: blur(8px);
           border-bottom: 1px solid #2a2c35; display: flex; gap: 16px; align-items: center; flex-wrap: wrap; }
  header h1 { font-size: 16px; margin: 0; }
  .hint { color: #ffd66b; font-size: 13px; }
  .progress { margin-left: auto; color: #9aa0ad; font-size: 13px; }
  button { font: inherit; padding: 8px 16px; border-radius: 8px; border: 0;
           background: #6c5ce7; color: #fff; cursor: pointer; }
  button:hover { background: #7d6ff0; }
  main { padding: 20px; }
  .city { margin-bottom: 34px; }
  .city h2 { font-size: 15px; display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap;
             border-bottom: 1px solid #2a2c35; padding-bottom: 6px; }
  .iata { font-family: ui-monospace, monospace; color: #6c5ce7; font-weight: 700; }
  .count { color: #9aa0ad; font-size: 13px; }
  .count.full { color: #4cd471; }
  .count.over { color: #ff6b6b; }
  .q { color: #6b7180; font-size: 12px; margin-left: auto; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; margin-top: 12px; }
  .cand { position: relative; display: block; border-radius: 10px; overflow: hidden;
          border: 3px solid transparent; cursor: pointer; background: #1d1f27; }
  .cand img { display: block; width: 100%; aspect-ratio: 3/2; object-fit: cover; }
  .cand .pick { position: absolute; top: 8px; right: 8px; width: 22px; height: 22px; }
  .cand.sel { border-color: #6c5ce7; }
  .cand .badge { position: absolute; top: 8px; left: 8px; z-index: 3; min-width: 24px; height: 24px;
                 padding: 0 6px; border-radius: 12px; background: #6c5ce7; color: #fff;
                 font-size: 13px; font-weight: 700; display: none; align-items: center; justify-content: center; }
  .cand.sel .badge { display: inline-flex; }
  .cand.hero .badge { background: #f7b731; color: #1a1a1a; }
  /* Heuristic flags from filter-photos.mjs — red border + reason chip. */
  .cand.flagged { border-color: #ff5b5b; }
  .cand .flag { position: absolute; bottom: 30px; left: 0; right: 0; z-index: 2;
                background: #ff5b5be6; color: #fff; font-size: 11px; font-weight: 700;
                padding: 3px 8px; letter-spacing: .3px; }
  body.hide-flagged .cand.flagged { display: none; }
  .credit { font-size: 11px; color: #b6bac4; padding: 6px 8px; }
  .credit a { color: #b6bac4; }
  .toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%);
           background: #4cd471; color: #062; padding: 10px 18px; border-radius: 8px;
           font-weight: 600; opacity: 0; transition: opacity .2s; pointer-events: none; }
  .toast.show { opacity: 1; }
</style>
</head>
<body>
<header>
  <h1>NextOut photo review</h1>
  <span class="hint">⚠ Skip photos with visible brand logos or recognizable faces close-up.</span>
  <span class="hint" style="color:#8fd6a0">✓ Pre-loaded: ${savedCities} from your saved selection + ${autoOnly} from auto — edit any, Save writes the merged set.</span>
  ${flaggedCount ? `<label style="font-size:13px;color:#ff9a9a;display:flex;gap:6px;align-items:center;cursor:pointer"><input type="checkbox" id="hideFlagged"> hide ${flaggedCount} flagged</label>` : ''}
  <span class="progress" id="progress">0 / ${totalCities} cities done</span>
  <button id="save">Save selection</button>
</header>
<main>
${blocks}
</main>
<div class="toast" id="toast"></div>
<script>
  // selection: iata -> ordered array of files (click order; first = hero, position 1).
  const TARGET = 5;
  // Pre-loaded selection: your saved picks layered over the auto picks (see server side).
  // Cities you never touch keep these; editing a city replaces just that city's array.
  // "Save selection" writes the whole merged object back to selected.json.
  const PRELOAD = ${JSON.stringify(preload)};
  const sel = {};
  for (const [iata, files] of Object.entries(PRELOAD)) sel[iata] = files.slice();

  function refreshCity(iata) {
    const files = sel[iata] || [];
    const countEl = document.querySelector('.count[data-iata="' + CSS.escape(iata) + '"]');
    if (countEl) {
      countEl.textContent = files.length + ' / ' + TARGET;
      countEl.classList.toggle('full', files.length === TARGET);
      countEl.classList.toggle('over', files.length > TARGET);
    }
    // Re-badge every candidate in this city with its 1-based position (hero = 1).
    document.querySelectorAll('.cand[data-iata="' + CSS.escape(iata) + '"]').forEach((el) => {
      const idx = files.indexOf(el.dataset.file);
      const on = idx !== -1;
      el.classList.toggle('sel', on);
      el.classList.toggle('hero', idx === 0);
      el.querySelector('.badge').textContent = on ? String(idx + 1) : '';
      el.querySelector('.pick').checked = on;
    });
    refreshProgress();
  }

  function refreshProgress() {
    const done = Object.values(sel).filter((a) => a.length === TARGET).length;
    const total = ${totalCities};
    document.getElementById('progress').textContent = done + ' / ' + total + ' cities done';
  }

  document.querySelectorAll('.cand').forEach((el) => {
    const cb = el.querySelector('.pick');
    // Toggle via the whole card; the checkbox reflects state (its own click bubbles here too).
    el.addEventListener('click', (e) => {
      if (e.target === cb) { /* let it toggle, handled below */ } else { e.preventDefault(); }
      const iata = el.dataset.iata, file = el.dataset.file;
      const arr = (sel[iata] ||= []);
      const at = arr.indexOf(file);
      if (at === -1) arr.push(file); else arr.splice(at, 1);
      refreshCity(iata);
    });
  });

  const hf = document.getElementById('hideFlagged');
  if (hf) hf.addEventListener('change', () => document.body.classList.toggle('hide-flagged', hf.checked));

  // Paint the pre-loaded picks (badges/positions/counts) on load.
  Object.keys(PRELOAD).forEach(refreshCity);

  document.getElementById('save').addEventListener('click', () => {
    // Drop empty cities; keep insertion (=click) order within each.
    const out = {};
    for (const [iata, files] of Object.entries(sel)) if (files.length) out[iata] = files;
    const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'selected.json';
    a.click();
    URL.revokeObjectURL(a.href);
    const t = document.getElementById('toast');
    const cities = Object.keys(out).length;
    t.textContent = 'Saved selected.json — ' + cities + ' cities. Put it in photos/.';
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), 3500);
  });
</script>
</body>
</html>`;

  await writeFile(OUT_PATH, html);
  console.log(`✓ Wrote ${path.relative(process.cwd(), OUT_PATH)} (${totalCities} cities).`);
  console.log('  Open it in a browser, pick 5 per city (first click = hero), then "Save selection".');
  console.log('  Move the downloaded selected.json into the photos/ folder for step 3.');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
