/* opfs.js — thin helpers over Origin Private File System.
 *
 * Used by loader.js to cache decompressed corpus entries between sessions
 * so we don't re-run libarchive (and its 25-extract stale-handle bug) on
 * every page load. Layout under the OPFS root:
 *
 *   corpora/
 *     <cacheKey>/
 *       manifest.json
 *       games/
 *         <index>.ndjson
 *         <index>.spectralz.gz
 *       .failed        newline-separated list of game indices that errored
 *       .complete      empty; written when the background expansion finishes
 *
 * Cache key is derived from filename + size + mtime (see computeCacheKey).
 * No content hashing — a re-downloaded file with new mtime invalidates the
 * cache, which is what we want.
 */

export function isOpfsAvailable() {
  return typeof navigator !== 'undefined'
      && !!navigator.storage
      && typeof navigator.storage.getDirectory === 'function';
}

/** Safe-ish cache key from a File. Filename is lightly sanitized; size
 *  and lastModified guard against same-name files being conflated. */
export function computeCacheKey(file) {
  const safeName = String(file.name || 'corpus').replace(/[^A-Za-z0-9._-]+/g, '_');
  return `${safeName}-${file.size ?? 0}-${file.lastModified ?? 0}`;
}

/** Return (creating if needed) the directory handle for corpora/<cacheKey>/.
 *  Throws if OPFS is unavailable. */
export async function getCorpusDir(cacheKey) {
  const root = await navigator.storage.getDirectory();
  const corpora = await root.getDirectoryHandle('corpora', { create: true });
  return corpora.getDirectoryHandle(cacheKey, { create: true });
}

/** Recursively resolve a slash-separated path into a directory handle,
 *  creating intermediate dirs when `create` is true. Returns the parent
 *  directory handle plus the final segment (the file basename). */
async function resolveParent(dir, path, create) {
  const segs = String(path).split('/').filter(Boolean);
  if (!segs.length) throw new Error('opfs: empty path');
  let here = dir;
  for (let i = 0; i < segs.length - 1; i++) {
    here = await here.getDirectoryHandle(segs[i], { create });
  }
  return { parent: here, name: segs[segs.length - 1] };
}

/** Write a Blob / ArrayBuffer / Uint8Array to `<dir>/<path>`, creating
 *  intermediate directories. Overwrites any existing entry. */
export async function writeFile(dir, path, data) {
  const { parent, name } = await resolveParent(dir, path, true);
  const fh = await parent.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  try {
    await w.write(data);
  } finally {
    await w.close();
  }
}

/** Append a text fragment to `<dir>/<path>`. Creates the file if missing.
 *  Used for the rolling `.failed` list. */
export async function appendText(dir, path, text) {
  const { parent, name } = await resolveParent(dir, path, true);
  const fh = await parent.getFileHandle(name, { create: true });
  const existing = await fh.getFile();
  const prev = existing.size > 0 ? await existing.text() : '';
  const w = await fh.createWritable();
  try {
    await w.write(prev + text);
  } finally {
    await w.close();
  }
}

/** Read `<dir>/<path>` and return a File, or null if the entry is missing. */
export async function readFile(dir, path) {
  const { parent, name } = await resolveParent(dir, path, false).catch(() => ({}));
  if (!parent) return null;
  try {
    const fh = await parent.getFileHandle(name, { create: false });
    return await fh.getFile();
  } catch (e) {
    if (e && (e.name === 'NotFoundError' || e.code === 8)) return null;
    throw e;
  }
}

/** True iff `<dir>/<path>` exists and is a regular file. */
export async function fileExists(dir, path) {
  const f = await readFile(dir, path).catch(() => null);
  return !!f;
}

/** Read the `.failed` file and return the set of failed game indices.
 *  Empty set if the file is missing. */
export async function readFailed(dir) {
  const out = new Set();
  const f = await readFile(dir, '.failed');
  if (!f) return out;
  const text = await f.text();
  for (const line of text.split('\n')) {
    const n = parseInt(line.trim(), 10);
    if (Number.isFinite(n)) out.add(n);
  }
  return out;
}

/** Record a failed game index. Deduplicates so repeated failures don't
 *  bloat the file. */
export async function appendFailed(dir, gameIndex) {
  const known = await readFailed(dir);
  if (known.has(gameIndex)) return;
  await appendText(dir, '.failed', `${gameIndex}\n`);
}

/** Write the .complete marker. Presence of this file means we can skip
 *  libarchive entirely on subsequent opens. */
export async function markComplete(dir) {
  await writeFile(dir, '.complete', new Uint8Array(0));
}

export async function isComplete(dir) {
  return await fileExists(dir, '.complete');
}
