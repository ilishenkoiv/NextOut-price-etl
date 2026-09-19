import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, access, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  validateKey, safeFolderName, resolveWithinBase, parseManifest, fetchBatch, renderReview,
} from './fetch-photos-batch.mjs';

const exists = (p) => access(p).then(() => true).catch(() => false);

// A fake Pexels photo. `n` unique photos for a query.
function fakePhotos(query, n = 8) {
  return Array.from({ length: n }, (_, i) => ({
    id: `${query}-${i}`,
    photographer: `Photographer ${i}`,
    photographer_url: `https://pexels.com/@p${i}`,
    url: `https://pexels.com/photo/${query}-${i}`,
    alt: `${query} ${i}`,
    avg_color: '#8899aa',
    width: 1200, height: 800,
    src: { large: `https://images.pexels.com/${query}-${i}-large.jpg` },
  }));
}

function makeDeps(overrides = {}) {
  const calls = { search: 0, download: 0 };
  const deps = {
    now: () => '2026-09-18T00:00:00.000Z',
    sleep: async () => {},
    search: async (q) => { calls.search++; return fakePhotos(q, 8); },
    download: async (_url, dest) => { calls.download++; await writeFile(dest, 'jpgbytes'); },
    ...overrides,
  };
  return { deps, calls };
}

const GOOD_MANIFEST = [
  { destinationId: 'madrid', key: 'MAD', place: 'Madrid', queries: ['Madrid Gran Via', 'Retiro park'] },
  { destinationId: 'zurich', key: 'place:zurich', place: 'Zurich', queries: ['Zurich old town Limmat'] },
];

test('validateKey accepts IATA and place:<id>, rejects malformed/traversal', () => {
  assert.equal(validateKey('MAD'), 'MAD');
  assert.equal(validateKey('place:zurich'), 'place:zurich');
  for (const bad of ['ab', 'MADD', 'place:Zurich', 'MA/D', 'place:z/x', '../etc', 'place:', ':zurich', 42, null]) {
    assert.throws(() => validateKey(bad), /Invalid resource key/, `should reject ${bad}`);
  }
});

test('safeFolderName maps place:zurich -> place-zurich and stays alnum', () => {
  assert.equal(safeFolderName('MAD'), 'MAD');
  assert.equal(safeFolderName('place:zurich'), 'place-zurich');
  assert.equal(safeFolderName('place:geneva'), 'place-geneva');
});

test('resolveWithinBase blocks escapes', () => {
  const base = path.resolve('/tmp/base');
  assert.ok(resolveWithinBase(base, 'MAD').startsWith(base));
  assert.throws(() => resolveWithinBase(base, '../evil'), /escapes output/);
  assert.throws(() => resolveWithinBase(base, '/etc/passwd'), /escapes output/);
});

test('parseManifest validates shape, duplicates and folder collisions', () => {
  assert.equal(parseManifest(GOOD_MANIFEST).length, 2);
  assert.equal(parseManifest({ entries: GOOD_MANIFEST }).length, 2);
  assert.throws(() => parseManifest([]), /non-empty/);
  assert.throws(() => parseManifest([{ destinationId: 'x', key: 'MAD', place: 'M' }]), /at least one query/);
  assert.throws(() => parseManifest([{ key: 'MAD', place: 'M', queries: ['q'] }]), /destinationId/);
  assert.throws(() => parseManifest([
    { destinationId: 'a', key: 'MAD', place: 'M', queries: ['q'] },
    { destinationId: 'b', key: 'MAD', place: 'M2', queries: ['q'] },
  ]), /Duplicate resource key/);
});

test('fetchBatch downloads candidates with full provenance into a run folder', async () => {
  const outBase = await mkdtemp(path.join(os.tmpdir(), 'pb-'));
  const { deps, calls } = makeDeps();
  const { runDir, runManifest } = await fetchBatch({ manifest: GOOD_MANIFEST, outBase, runId: 'run-1', deps });

  assert.ok(runDir.endsWith(path.join('run-1')));
  const mad = runManifest.entries['MAD'];
  // PER_QUERY_CAP=2 (mirrors fetch-photos.mjs): 2 queries × 2 = 4 pooled candidates.
  assert.equal(mad.candidates.length, 4);
  assert.equal(mad.destinationId, 'madrid');
  const c = mad.candidates[0];
  for (const f of ['pexels_id', 'photographer', 'photographer_url', 'pexels_url', 'query', 'downloaded_at', 'avg_color']) {
    assert.ok(c[f] !== undefined && c[f] !== '', `candidate missing ${f}`);
  }
  // place:zurich stored under safe folder place-zurich
  assert.equal(runManifest.entries['place:zurich'].folder, 'place-zurich');
  assert.ok(await exists(path.join(runDir, 'place-zurich', '1.jpg')));
  assert.ok(await exists(path.join(runDir, 'manifest.json')));
  assert.ok(await exists(path.join(runDir, 'review.html')));
  // pooling caps 2 per query, so MAD (2 queries) issued 2 searches
  assert.equal(calls.search, 3); // MAD: 2 queries, zurich: 1 query
});

test('resume within the same run does not refetch existing results', async () => {
  const outBase = await mkdtemp(path.join(os.tmpdir(), 'pb-'));
  const first = makeDeps();
  await fetchBatch({ manifest: GOOD_MANIFEST, outBase, runId: 'run-x', deps: first.deps });
  const before = first.calls.search;
  const second = makeDeps();
  await fetchBatch({ manifest: GOOD_MANIFEST, outBase, runId: 'run-x', deps: second.deps });
  assert.ok(before > 0);
  assert.equal(second.calls.search, 0, 'second run must skip already-fetched keys');
});

test('a separate run writes a new folder and leaves the old run intact', async () => {
  const outBase = await mkdtemp(path.join(os.tmpdir(), 'pb-'));
  await fetchBatch({ manifest: GOOD_MANIFEST, outBase, runId: 'run-a', deps: makeDeps().deps });
  await fetchBatch({ manifest: GOOD_MANIFEST, outBase, runId: 'run-b', deps: makeDeps().deps });
  assert.ok(await exists(path.join(outBase, 'run-a', 'manifest.json')));
  assert.ok(await exists(path.join(outBase, 'run-b', 'manifest.json')));
  assert.ok(await exists(path.join(outBase, 'run-a', 'MAD', '1.jpg')));
});

test('under-filled place is flagged in problem-keys.txt', async () => {
  const outBase = await mkdtemp(path.join(os.tmpdir(), 'pb-'));
  const deps = makeDeps({ search: async (q) => fakePhotos(q, 1) }).deps; // 1 result/query, cap 2 → <5
  const { runDir, problems } = await fetchBatch({
    manifest: [{ destinationId: 'bari', key: 'BRI', place: 'Bari', queries: ['Bari old town'] }],
    outBase, runId: 'run-thin', deps,
  });
  assert.equal(problems.length, 1);
  assert.ok(await exists(path.join(runDir, 'problem-keys.txt')));
});

test('--only filter fetches just the named keys', async () => {
  const outBase = await mkdtemp(path.join(os.tmpdir(), 'pb-'));
  const { calls, deps } = makeDeps();
  const { runManifest } = await fetchBatch({ manifest: GOOD_MANIFEST, outBase, runId: 'r', only: ['MAD'], deps });
  assert.ok(runManifest.entries['MAD']);
  assert.equal(runManifest.entries['place:zurich'], undefined);
  assert.equal(calls.search, 2); // only MAD's two queries
});

test('renderReview embeds concrete image paths and attribution', () => {
  const html = renderReview({ run: 'r', entries: { MAD: {
    destinationId: 'madrid', key: 'MAD', place: 'Madrid',
    candidates: [{ path: 'MAD/1.jpg', pexels_id: 'x1', photographer: 'Ann', photographer_url: 'u', pexels_url: 'pu', alt: 'a', query: 'q' }],
  } } });
  assert.match(html, /src="MAD\/1\.jpg"/);
  assert.match(html, /Ann/);
  assert.match(html, /Pexels/);
});
