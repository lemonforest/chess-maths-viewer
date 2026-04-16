/* loader.js — corpus pipeline
 *
 * Pipeline:
 *   1. User drops a .7z file.
 *   2. libarchive.js (Web Worker) walks the archive directory (no byte
 *      extraction yet) and returns a tree of CompressedFile handles
 *      via getFilesObject().
 *   3. Locate manifest.json (by basename), extract only that one entry,
 *      parse it, and resolve sibling paths relative to its directory.
 *   4. Index every game in the manifest into corpus.games[i] holding
 *      *only* path strings. PGN text, NDJSON plies, and spectral data
 *      are all parsed on demand when a game is selected.
 *   5. Eager-parse only game[0] so the viewer is interactive on reveal.
 *
 * On selection, ensureGameData(corpus, idx) pulls the NDJSON + spectralz
 * bytes through the libarchive worker, parses them, and touches an LRU
 * keyed by gameIndex. When the LRU fills (default 50), older entries'
 * parsed state is nulled; manifest metadata is never evicted.
 *
 * Progress events via onProgress:
 *   { phase, msg, fraction }     (throttled to ~10 Hz, guaranteed flush
 *                                 on 'done' and 'error')
 */

import {
  CHANNELS,
  channelEnergyForPly,
  parseEvalString,
} from './spectral.js';
import { createLRU } from './lru.js';

// Resolved relative to this module so the paths work both from the repo root
// and from any subdirectory that the site is served from.
const LIBARCHIVE_URL        = new URL('../lib/libarchive/libarchive.js', import.meta.url).href;
const LIBARCHIVE_WORKER_URL = new URL('../lib/libarchive/worker-bundle.js', import.meta.url).href;

// Cap on parsed game state (game.spectral + game.plies). Roughly
// 50 games × ~400KB avg ≈ 20MB retained, which leaves plenty of
// headroom at 15k-game scale. The currently-active game is pinned
// so it never evicts even if a user clicks through many others.
const LRU_CAPACITY = 50;

let _ArchivePromise = null;
function importArchive() {
  if (!_ArchivePromise) {
    _ArchivePromise = import(/* @vite-ignore */ LIBARCHIVE_URL).then((mod) => {
      const Archive = mod.Archive || (mod.default && mod.default.Archive);
      if (!Archive) throw new Error('libarchive.js: Archive class not found in module');
      Archive.init({ workerUrl: LIBARCHIVE_WORKER_URL });
      return Archive;
    });
  }
  return _ArchivePromise;
}

/* ------------------------------------------------------------------ *
 * Progress throttle
 * ------------------------------------------------------------------ */
function throttleProgress(onProgress, minIntervalMs = 100) {
  let last = 0;
  let pending = null;
  let rafId = 0;
  const flush = () => {
    if (!pending) return;
    const p = pending;
    pending = null;
    last = performance.now();
    try { onProgress(p); } catch (e) { console.error('onProgress:', e); }
  };
  return (phase, msg, fraction) => {
    pending = { phase, msg, fraction };
    const now = performance.now();
    // Always flush terminal phases immediately.
    if (phase === 'done' || phase === 'error' || now - last > minIntervalMs) {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      flush();
      return;
    }
    if (!rafId) {
      rafId = requestAnimationFrame(() => { rafId = 0; flush(); });
    }
  };
}

/* ------------------------------------------------------------------ *
 * Public entry point
 * ------------------------------------------------------------------ */
export async function loadCorpusFromFile(file, onProgress = () => {}) {
  const emit = throttleProgress(onProgress);

  emit('decompress', `Opening ${file.name} (${formatBytes(file.size)})…`, 0.02);

  const handle = await openArchive(file);
  emit('decompress', `Archive indexed: ${handle.compressedMap.size} entries`, 0.18);

  // Locate manifest.json (by basename) so we tolerate a wrapping directory.
  const manifestRef = findEntry(handle.compressedMap, 'manifest.json');
  if (!manifestRef) throw new Error('manifest.json not found in archive');

  const baseDir = manifestRef.dir;
  const manifestFile = await manifestRef.file.extract();
  const manifestText = await manifestFile.text();
  const manifest = JSON.parse(manifestText);
  emit('manifest', `Manifest: ${manifest.games.length} games · run ${manifest.run_id || '—'}`, 0.22);

  // Index every game into a lightweight record. The manifest row itself
  // (meta) is kept — it drives the corpus table and the info panel.
  // Bulk payloads (pgn, plies, spectral) are populated lazily on select.
  const games = {};
  const totalGames = manifest.games.length;
  for (let i = 0; i < totalGames; i++) {
    const g = manifest.games[i];
    const gameIndex = g.index;
    games[gameIndex] = {
      meta: g,
      pgn: null,                       // lazy: ensureGameData
      plies: null,                     // lazy: ensureGameData
      spectral: null,                  // lazy: ensureGameData
      _ndjsonPath:   resolvePath(handle.compressedMap, baseDir, g.ndjson),
      _pgnPath:      resolvePath(handle.compressedMap, baseDir, g.pgn),
      _spectralPath: resolvePath(handle.compressedMap, baseDir, g.spectralz),
      _loadPromise: null,
    };
    // Emit progress at ~10 Hz max — the throttle coalesces per-game calls.
    if ((i & 63) === 0 || i === totalGames - 1) {
      const frac = 0.22 + 0.18 * ((i + 1) / totalGames);
      emit('index', `Indexed ${i + 1}/${totalGames} games`, frac);
    }
  }

  // Augment manifest rows with derived mean_FT for table sort convenience.
  for (const g of manifest.games) {
    g.mean_FT = (g.mean_F1 ?? 0) + (g.mean_F2 ?? 0) + (g.mean_F3 ?? 0);
  }

  // Game variant: "chess" (default, backwards-compatible) or "othello".
  // Manifests predating Othello support have no `variant` key; treat those
  // as chess corpora unchanged.
  const variant = (manifest.variant || manifest.game || 'chess').toLowerCase();

  const corpus = {
    manifest,
    games,
    variant,
    sourceName: file.name,
    sourceSize: file.size,
    _handle: handle,
    _lru: null,
  };
  corpus._lru = createLRU(LRU_CAPACITY, (evictedIdx) => {
    const g = corpus.games[evictedIdx];
    if (!g) return;
    // Nulling game.spectral drops the 200KB decompressed ArrayBuffer plus
    // the Float32Array views and the precomputed channelEnergies. Nulling
    // game.plies drops the parsed NDJSON. _loadPromise is nulled so a
    // future ensureGameData re-parses instead of resolving to stale nulls.
    g.spectral = null;
    g.plies = null;
    g.pgn = null;
    g._loadPromise = null;
  });

  // Eager-parse game 1 so the viewer is immediately interactive.
  const firstIndex = manifest.games[0].index;
  emit('spectral', `Decoding game ${firstIndex}…`, 0.5);
  await ensureGameData(corpus, firstIndex);
  emit('spectral', `Ready: game ${firstIndex}`, 0.95);

  emit('done', 'Ready', 1.0);
  return corpus;
}

/** Tear down a corpus: close the libarchive worker and drop parsed state.
 *  Idempotent — safe to call twice; the second call resolves to the first
 *  call's pending promise so a rapid reload-button mash doesn't double-close. */
export async function closeCorpus(corpus) {
  if (!corpus || !corpus._handle) return;
  if (corpus._closing) return corpus._closing;
  corpus._closing = (async () => {
    try {
      await corpus._handle.archive.close();
    } catch (e) {
      console.warn('archive.close:', e);
    }
    corpus._handle = null;
    corpus._lru && corpus._lru.clear();
  })();
  return corpus._closing;
}

/* ------------------------------------------------------------------ *
 * Lazy per-game loader
 *
 * Called by app.js on every selectGame (and once at load time for
 * game 1). Coalesces concurrent calls via game._loadPromise.
 * ------------------------------------------------------------------ */
export async function ensureGameData(corpus, gameIndex) {
  const game = corpus.games[gameIndex];
  if (!game) throw new Error(`Unknown game ${gameIndex}`);
  if (game.plies && game.spectral) {
    corpus._lru.touch(gameIndex);
    return game;
  }
  if (game._loadPromise) return game._loadPromise;

  game._loadPromise = (async () => {
    // NDJSON (per-ply FEN, SAN, eval, clock)
    if (!game.plies && game._ndjsonPath) {
      const cf = corpus._handle.compressedMap.get(game._ndjsonPath);
      if (!cf) throw new Error(`ndjson entry missing: ${game._ndjsonPath}`);
      const ndjsonFile = await cf.extract();
      const text = await ndjsonFile.text();
      game.plies = parseNdjson(text);
    }
    // Spectralz (decompressed Float32 lattice)
    if (!game.spectral && game._spectralPath) {
      const cf = corpus._handle.compressedMap.get(game._spectralPath);
      if (!cf) throw new Error(`spectralz entry missing: ${game._spectralPath}`);
      const spectralFile = await cf.extract();
      const buf = await spectralFile.arrayBuffer();
      const decompressed = await gunzip(buf);
      const parsed = parseSpectralz(decompressed);
      game.spectral = enrichSpectral(parsed);
    }
    // PGN is not needed for the viewer (manifest carries eco/opening/white/
    // black/result/elo). We leave game.pgn null and board.js's opening
    // fallback skips the PGN regex path.
    corpus._lru.touch(gameIndex);
    return game;
  })();

  try {
    return await game._loadPromise;
  } catch (e) {
    game._loadPromise = null;    // allow retry
    throw e;
  }
}

/* ------------------------------------------------------------------ *
 * Back-compat alias for any call site still using parseGameSpectral.
 * ------------------------------------------------------------------ */
export async function parseGameSpectral(corpus, gameIndex) {
  const g = await ensureGameData(corpus, gameIndex);
  return g.spectral;
}

/* ------------------------------------------------------------------ *
 * Archive open: walk the directory (no extraction) via getFilesObject.
 *
 * Returns { archive, compressedMap } where compressedMap is
 * Map<normalizedPath, CompressedFile>. Each CompressedFile's .extract()
 * round-trips through the libarchive worker to pull just that entry's
 * bytes on demand.
 *
 * The archive instance is kept alive for the session; closing it would
 * terminate the worker and invalidate every CompressedFile handle. On
 * reload (see app.js reload-btn teardown), closeCorpus() is called.
 * ------------------------------------------------------------------ */
async function openArchive(file) {
  const Archive = await importArchive();
  const archive = await Archive.open(file);
  const tree = await archive.getFilesObject();
  const entries = flattenTree(tree);

  const map = new Map();
  for (const { file: cf, path } of entries) {
    if (!cf || typeof cf.extract !== 'function') continue;
    const norm = normalisePath(path ? `${path}/${cf.name}` : cf.name);
    map.set(norm, cf);
  }
  return { archive, compressedMap: map };
}

function flattenTree(tree, prefix = '') {
  const out = [];
  for (const [name, value] of Object.entries(tree)) {
    const here = prefix ? `${prefix}/${name}` : name;
    // Leaf test: CompressedFile exposes .extract(); File does too but we
    // prefer the duck-typed check to avoid coupling to either class.
    if (value && typeof value === 'object' && typeof value.extract === 'function') {
      out.push({ file: value, path: prefix });
    } else if (value && typeof value === 'object') {
      out.push(...flattenTree(value, here));
    }
  }
  return out;
}

function normalisePath(p) {
  return String(p).replace(/^\.?\/+/, '').replace(/\\/g, '/');
}

function findEntry(fileMap, basename) {
  for (const [path, file] of fileMap) {
    const segs = path.split('/');
    if (segs[segs.length - 1] === basename) {
      const dir = segs.slice(0, -1).join('/');
      return { file, path, dir };
    }
  }
  return null;
}

/** Resolve a manifest-relative path against the archive's compressed map.
 *  Returns the normalised key used in the Map, or null if not found.
 *  We store the string key (not the CompressedFile) on the game record
 *  so the game object stays cheap and uniform across evictions. */
function resolvePath(fileMap, baseDir, relPath) {
  if (!relPath) return null;
  const candidates = [
    baseDir ? `${baseDir}/${relPath}` : relPath,
    relPath,
  ];
  for (const c of candidates) {
    const norm = normalisePath(c);
    if (fileMap.has(norm)) return norm;
  }
  // Last resort: match by basename
  const want = relPath.split('/').pop();
  for (const p of fileMap.keys()) {
    if (p.endsWith('/' + want) || p === want) return p;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * NDJSON parser
 * ------------------------------------------------------------------ */
function parseNdjson(text) {
  const lines = text.split('\n');
  const plies = [];
  let skipped = 0;
  for (const line of lines) {
    if (!line) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { skipped++; continue; }
    if (obj.bridge_version || obj.type === 'game_header') continue;
    if (typeof obj.ply !== 'number') { skipped++; continue; }
    plies.push(obj);
  }
  if (skipped) console.warn(`parseNdjson: skipped ${skipped} malformed line(s)`);
  // Ensure ply array is dense + ordered
  plies.sort((a, b) => a.ply - b.ply);
  return plies;
}

/* ------------------------------------------------------------------ *
 * Spectralz binary parser
 * ------------------------------------------------------------------ */
const SPECTRALZ_MAGIC = 'LARTPSEC';
const HEADER_SIZE = 256;
const DIM = 640;

function parseSpectralz(arrayBuffer) {
  const view = new DataView(arrayBuffer);
  const magic = new TextDecoder().decode(new Uint8Array(arrayBuffer, 0, 8));
  if (magic !== SPECTRALZ_MAGIC) {
    throw new Error(`Not a spectralz file (magic="${magic}")`);
  }
  const version = view.getUint32(8, true);
  const dim     = view.getUint32(12, true);
  const stride  = view.getUint32(16, true);
  const nPlies  = view.getUint32(20, true);

  if (dim !== DIM) {
    throw new Error(`Unsupported spectralz dim=${dim} (expected ${DIM})`);
  }
  const expected = HEADER_SIZE + nPlies * stride;
  if (arrayBuffer.byteLength < expected) {
    throw new Error(`spectralz truncated: have ${arrayBuffer.byteLength}, need ${expected}`);
  }

  const plies = new Array(nPlies);
  for (let p = 0; p < nPlies; p++) {
    const offset = HEADER_SIZE + p * stride;
    plies[p] = new Float32Array(arrayBuffer, offset, DIM); // view, no copy
  }
  return { version, dim, stride, nPlies, plies, _buffer: arrayBuffer };
}

/* Compute per-channel energy series + per-channel min/max + per-(channel,mode)
 * min/max so the heatmap and chart can render without scanning the data
 * each frame. */
function enrichSpectral(parsed) {
  const { plies, nPlies } = parsed;
  const channelEnergies = {};
  for (const ch of CHANNELS) {
    channelEnergies[ch.id] = new Float32Array(nPlies);
  }
  // Derived: total fiber
  channelEnergies.FT = new Float32Array(nPlies);

  // Per-channel value min/max (across all modes & plies in that channel)
  const valueMinMax = {};
  for (const ch of CHANNELS) valueMinMax[ch.id] = { min: Infinity, max: -Infinity };

  for (let p = 0; p < nPlies; p++) {
    const arr = plies[p];
    for (let c = 0; c < CHANNELS.length; c++) {
      const ch = CHANNELS[c];
      const start = ch.index * 64;
      let energy = 0;
      let mn = valueMinMax[ch.id].min;
      let mx = valueMinMax[ch.id].max;
      for (let i = start; i < start + 64; i++) {
        const v = arr[i];
        energy += v * v;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      channelEnergies[ch.id][p] = energy;
      valueMinMax[ch.id].min = mn;
      valueMinMax[ch.id].max = mx;
    }
    channelEnergies.FT[p] =
      channelEnergies.F1[p] + channelEnergies.F2[p] + channelEnergies.F3[p];
  }

  // Mean & sigma per channel for z-score line chart
  const stats = {};
  for (const id of Object.keys(channelEnergies)) {
    const arr = channelEnergies[id];
    let s = 0;
    for (let i = 0; i < arr.length; i++) s += arr[i];
    const mean = s / arr.length;
    let v = 0;
    for (let i = 0; i < arr.length; i++) {
      const d = arr[i] - mean;
      v += d * d;
    }
    const sigma = Math.sqrt(v / Math.max(1, arr.length));
    stats[id] = { mean, sigma: sigma || 1 };
  }

  // Eval series (parsed once, here, for chart overlay) — populated by app.js
  // from plies; we don't have plies meta here.

  return {
    ...parsed,
    channelEnergies,   // Map id → Float32Array(nPlies)
    valueMinMax,       // Map id → {min,max}
    stats,             // Map id → {mean,sigma}
    helpers: { channelEnergyForPly },  // re-export for callers
  };
}

/* ------------------------------------------------------------------ *
 * Gzip decompression
 * ------------------------------------------------------------------ */
async function gunzip(buf) {
  if (typeof DecompressionStream === 'function') {
    const stream = new Response(buf).body.pipeThrough(new DecompressionStream('gzip'));
    return await new Response(stream).arrayBuffer();
  }
  // Fallback: pako global if loaded
  if (typeof window !== 'undefined' && window.pako) {
    return window.pako.ungzip(new Uint8Array(buf)).buffer;
  }
  throw new Error('No gzip decompressor available (DecompressionStream missing and pako not loaded)');
}

/* ------------------------------------------------------------------ *
 * Format helpers
 * ------------------------------------------------------------------ */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n < 10 ? n.toFixed(2) : n < 100 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
}

export { parseSpectralz, parseNdjson, parseEvalString };
