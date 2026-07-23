// scripts/upload-photos.mjs — STEP 4 (final) of the photo pipeline.
//
// Uploads photos/optimized/**.webp to Supabase Storage (public bucket "destinations") and
// writes one provenance row per photo to the destination_photos table. Provenance is merged
// from manifest.json (photographer / source URLs / avg_color, keyed by the ORIGINAL file
// name) and selected.json (which files, in which ORDER = position).
//
//   Storage object:  destinations/{IATA}/{position}.webp      (bucket = "destinations")
//   Table row:       destination_photos(dest, position, storage_path, pexels_id,
//                    photographer, photographer_url, pexels_url, alt, avg_color, downloaded_at)
//
//   storage_path is the IN-BUCKET object key, "{IATA}/{position}.webp" — i.e. what
//   supabase.storage.from('destinations').getPublicUrl(storage_path) expects. (If the app
//   instead prefixes the bucket, change PATH_INCLUDES_BUCKET below.)
//
//   PowerShell:  $env:SUPABASE_SERVICE_KEY="..."; node scripts/upload-photos.mjs
//   bash:        SUPABASE_SERVICE_KEY=... node scripts/upload-photos.mjs
//
// SUPABASE_SERVICE_KEY comes from env ONLY (secret, repo is PUBLIC). SUPABASE_URL defaults to
// the project URL (public, not a secret) — same as the price collector.
//
// Re-runnable: storage upload uses upsert; the table write upserts on (dest, position).
//
// COVERAGE REPORT (end of the run): after uploading, the script compares the destination_photos
// table against the destination catalogue and prints which destinations have NO photos, exiting
// non-zero if any do. Uploading N files was never the question worth answering — "does every
// destination in the app have photos?" is, and for a long time nothing asked it: the eight East
// Asia cities (PEK PVG CAN TFU CTS FUK PUS CJU) were prepared locally, never uploaded, and the
// output gave no hint. A run that leaves the catalogue uncovered now fails loudly.

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DESTINATIONS } from '../src/data/destinations.js';
import { CITIES } from '../src/data/cities.js';

// ── Config / secrets (env only) ──────────────────────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || 'https://xpalogebawoljlafsafs.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const BUCKET = 'destinations';
const PATH_INCLUDES_BUCKET = false; // set true if the app builds URLs from "destinations/{IATA}/..."

if (!SUPABASE_SERVICE_KEY) {
  console.error('ERROR: SUPABASE_SERVICE_KEY is not set — nothing was uploaded.');
  console.error('  PowerShell:  $env:SUPABASE_SERVICE_KEY="..."; node scripts/upload-photos.mjs');
  console.error('  bash:        SUPABASE_SERVICE_KEY=... node scripts/upload-photos.mjs');
  process.exit(1);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PHOTOS_DIR = path.join(__dirname, '..', 'photos');
const MANIFEST_PATH = path.join(PHOTOS_DIR, 'manifest.json');
const SELECTED_PATH = path.join(PHOTOS_DIR, 'selected.json');
const OPTIMIZED_ROOT = path.join(PHOTOS_DIR, 'optimized');

const exists = (p) => access(p).then(() => true).catch(() => false);

// Same JWT-role check as fetch-prices.mjs: confirm a service_role key is used (anon would be
// denied by RLS / storage policies). This reads the PUBLIC role claim, never the secret.
function keyRole(key) {
  try {
    const seg = key.split('.')[1];
    if (!seg) return '(opaque non-JWT key)';
    return JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')).role || '(no role claim)';
  } catch {
    return '(unreadable)';
  }
}
const SERVICE_KEY_ROLE = keyRole(SUPABASE_SERVICE_KEY);

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
  realtime: { transport: WebSocket }, // never connected; satisfies supabase-js on any Node
});
if (SERVICE_KEY_ROLE !== 'service_role') {
  console.warn(`WARNING: SUPABASE_SERVICE_KEY role = "${SERVICE_KEY_ROLE}" (expected "service_role") — writes will likely be denied.`);
}

// ── Coverage vs the catalogue ────────────────────────────────────────────────
// Reads the TABLE rather than selected.json on purpose: the table is what the app actually
// sees, so this also catches rows that failed to write — not merely cities nobody selected.
// Returns true when every destination is covered.
async function reportCoverage() {
  // PostgREST caps ONE response at 1000 rows and reports nothing when it truncates: `error`
  // is null and the array is simply short. This table is ~669 rows today and its ceiling is
  // 132 destinations x 8 photos = 1056 — past the cap — so paging is required, not defensive.
  // .order() is what makes paging stable: without ORDER BY, Postgres gives no guarantee that
  // page 2 resumes where page 1 stopped, and a row can repeat or vanish. A miscount here
  // would report a covered destination as missing, which is exactly the lie this block exists
  // to prevent.
  const PAGE = 1000;
  let offset = 0;
  const rowsByDest = new Map(); // dest -> row count
  for (;;) {
    const { data, error } = await supabase
      .from('destination_photos')
      .select('dest')
      .order('dest', { ascending: true })
      .order('position', { ascending: true })
      .range(offset, offset + PAGE - 1);
    if (error) {
      console.error(`\nERROR: could not read destination_photos to verify coverage — ${error.message}`);
      console.error('The upload itself succeeded; the catalogue check did NOT run, so coverage is UNKNOWN.');
      return false;
    }
    for (const r of data) rowsByDest.set(r.dest, (rowsByDest.get(r.dest) ?? 0) + 1);
    if (data.length < PAGE) break;
    offset += PAGE;
  }

  const nameOf = (iata) => {
    const c = CITIES[iata];
    return c ? `${c.city}, ${c.country}` : '(no name in src/data/cities.js)';
  };
  const covered = DESTINATIONS.filter((d) => rowsByDest.has(d.iata));
  const uncovered = DESTINATIONS.filter((d) => !rowsByDest.has(d.iata));
  const catalogue = new Set(DESTINATIONS.map((d) => d.iata));
  const orphans = [...rowsByDest.keys()].filter((iata) => !catalogue.has(iata)).sort();
  const totalRows = [...rowsByDest.values()].reduce((a, b) => a + b, 0);

  console.log('\n── Coverage vs the destination catalogue ──────────────────────────');
  console.log(`Destinations with photos : ${covered.length}/${DESTINATIONS.length}`);
  console.log(`Rows in destination_photos: ${totalRows} across ${rowsByDest.size} dest code(s)`);

  if (uncovered.length) {
    console.log(`\n✗ ${uncovered.length} destination(s) WITHOUT photos — their cards render with no hero and no thumbnail:`);
    for (const d of uncovered) console.log(`    ${d.iata}  ${nameOf(d.iata)}`);
    console.log('\n  Fix: run the pipeline for them — fetch-photos → review → optimize-photos → this script.');
  } else {
    console.log('\n✓ Every destination in the catalogue has photos.');
  }

  // Orphans are stale, not broken: the app reads by dest, so a row for a destination it no
  // longer knows is simply never looked up. Reported, but deliberately NOT a failure — they
  // cost nothing and deleting them is a manual, destructive call.
  if (orphans.length) {
    console.log(`\n! ${orphans.length} dest code(s) in the table match no destination (stale rows from removed destinations):`);
    for (const iata of orphans) console.log(`    ${iata}  ${rowsByDest.get(iata)} row(s)`);
    console.log('  Harmless to the app. Delete by hand if you want the table clean.');
  }

  return uncovered.length === 0;
}

async function main() {
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const selected = JSON.parse(await readFile(SELECTED_PATH, 'utf8'));

  const iatas = Object.keys(selected);
  const rows = [];
  const publicUrls = [];
  let uploaded = 0, missing = 0;

  for (let i = 0; i < iatas.length; i++) {
    const iata = iatas[i];
    const files = selected[iata] || [];
    const candidates = manifest[iata]?.candidates || [];

    for (let pos = 0; pos < files.length; pos++) {
      const origFile = files[pos];
      const position = pos + 1;                       // 1 = hero
      const localPath = path.join(OPTIMIZED_ROOT, iata, `${position}.webp`);
      const objectKey = `${iata}/${position}.webp`;   // in-bucket key
      const storagePath = PATH_INCLUDES_BUCKET ? `${BUCKET}/${objectKey}` : objectKey;

      if (!(await exists(localPath))) {
        console.warn(`  ${iata} pos ${position}: ${path.relative(process.cwd(), localPath)} missing — run step 3. Skipped.`);
        missing++;
        continue;
      }

      const body = await readFile(localPath);
      const { error: upErr } = await supabase.storage
        .from(BUCKET)
        .upload(objectKey, body, { contentType: 'image/webp', upsert: true });
      if (upErr) {
        console.error(`  ${iata} pos ${position}: upload FAILED — ${upErr.message}`);
        continue;
      }
      uploaded++;

      // Provenance for this exact file (match the ORIGINAL candidate file name).
      const prov = candidates.find((c) => c.file === origFile) || {};
      rows.push({
        dest: iata,
        position,
        storage_path: storagePath,
        pexels_id: prov.pexels_id ?? null,
        photographer: prov.photographer ?? null,
        photographer_url: prov.photographer_url ?? null,
        pexels_url: prov.pexels_url ?? null,
        alt: prov.alt ?? null,
        avg_color: prov.avg_color ?? null,
        downloaded_at: prov.downloaded_at ?? null,
      });

      const { data: pub } = supabase.storage.from(BUCKET).getPublicUrl(objectKey);
      if (position === 1) publicUrls.push(pub.publicUrl); // print one (hero) per city
    }
    console.log(`[${i + 1}/${iatas.length}] ${iata} — ${files.length} photo(s) processed`);
  }

  if (!rows.length) {
    console.error('\nNothing to write — no optimized photos found. Run step 3 first.');
    process.exit(1);
  }

  // Upsert on (dest, position) so a re-run replaces rather than duplicates.
  const { error: dbErr } = await supabase
    .from('destination_photos')
    .upsert(rows, { onConflict: 'dest,position' });
  if (dbErr) {
    console.error(`\nERROR writing destination_photos: ${dbErr.message}`);
    process.exit(1);
  }

  console.log(`\n✓ Uploaded ${uploaded} object(s) to bucket "${BUCKET}"${missing ? `, ${missing} missing` : ''}.`);
  console.log(`✓ Wrote ${rows.length} row(s) to destination_photos.`);
  console.log('\nSpot-check hero URLs:');
  for (const u of publicUrls.slice(0, 10)) console.log('  ' + u);
  if (publicUrls.length > 10) console.log(`  … and ${publicUrls.length - 10} more.`);

  // Last thing on screen, so the state of the catalogue is what the operator walks away with.
  const complete = await reportCoverage();
  if (!complete) {
    // Exit 1 does NOT mean the upload failed — it did what it was asked. It means the app
    // still has destinations with no photos, which is the condition worth interrupting for.
    console.error('\nExit 1: upload finished, but the catalogue is NOT fully covered (see above).');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
