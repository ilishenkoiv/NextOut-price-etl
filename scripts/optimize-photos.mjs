// scripts/optimize-photos.mjs — STEP 3 of the photo pipeline.
//
// Reads photos/selected.json (your step-2 picks, order = position) and converts each chosen
// candidate to a web-ready WebP: resized to fit 1200×800, quality ~80 (~120 KB each). Output:
//
//     photos/optimized/{IATA}/{position}.webp        (position 1..5, 1 = hero)
//
// ~625 photos × ~120 KB ≈ 75 MB total — well within the 1 GB Supabase Storage bucket.
//
// Uses `sharp` (a local, one-off dev dependency — fine here; the app never runs this).
//   npm install            # picks up sharp from package.json devDependencies
//   node scripts/optimize-photos.mjs
//
// Idempotent: an already-optimized {position}.webp is skipped unless you pass --force.

import { mkdir, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHOTOS_DIR = path.join(__dirname, '..', 'photos');
const SELECTED_PATH = path.join(PHOTOS_DIR, 'selected.json');
const OUT_ROOT = path.join(PHOTOS_DIR, 'optimized');

const WIDTH = 1200;
const HEIGHT = 800;
const QUALITY = 80;
const FORCE = process.argv.includes('--force');

const exists = (p) => access(p).then(() => true).catch(() => false);

async function main() {
  let selected;
  try {
    selected = JSON.parse(await readFile(SELECTED_PATH, 'utf8'));
  } catch (err) {
    console.error(`ERROR: could not read ${path.relative(process.cwd(), SELECTED_PATH)} — run step 2 first.`);
    console.error(`  ${err.message}`);
    process.exit(1);
  }

  const iatas = Object.keys(selected);
  let written = 0, skipped = 0, missing = 0;

  for (let i = 0; i < iatas.length; i++) {
    const iata = iatas[i];
    const files = selected[iata] || [];
    const outDir = path.join(OUT_ROOT, iata);
    await mkdir(outDir, { recursive: true });

    const done = [];
    for (let pos = 0; pos < files.length; pos++) {
      const srcFile = files[pos];
      const position = pos + 1;                       // 1-based; 1 = hero
      const src = path.join(PHOTOS_DIR, iata, srcFile);
      const out = path.join(outDir, `${position}.webp`);

      if (!(await exists(src))) {
        console.warn(`  ${iata} pos ${position}: source ${srcFile} missing — skipped`);
        missing++;
        continue;
      }
      if (!FORCE && (await exists(out))) {
        skipped++;
        done.push(position);
        continue;
      }
      // `inside` fit + no enlargement: never upscale a small source, never crop.
      await sharp(src)
        .resize(WIDTH, HEIGHT, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: QUALITY })
        .toFile(out);
      written++;
      done.push(position);
    }
    console.log(`[${i + 1}/${iatas.length}] ${iata} — ${done.length} webp (positions ${done.join(', ') || '—'})`);
  }

  console.log(`\n✓ Optimized: ${written} written, ${skipped} already done, ${missing} missing source.`);
  console.log(`✓ Output: ${path.relative(process.cwd(), OUT_ROOT)}/{IATA}/{1..5}.webp`);
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
