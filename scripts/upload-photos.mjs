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

import { createClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
