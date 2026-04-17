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
import {
  isOpfsAvailable,
  computeCacheKey,
  getCorpusDir,
  writeFile as opfsWrite,
  readFile as opfsRead,
  fileExists as opfsFileExists,
  readFailed as opfsReadFailed,
  appendFailed as opfsAppendFailed,
  markComplete as opfsMarkComplete,
  isComplete as opfsIsComplete,
} from './opfs.js';

// Resolved relative to this module so the paths work both from the repo root
// and from any subdirectory that the site is served from.
const LIBARCHIVE_URL        = new URL('../lib/libarchive/libarchive.js', import.meta.url).href;
const LIBARCHIVE_WORKER_URL = new URL('../lib/libarchive/worker-bundle.js', import.meta.url).href;

// Cap on parsed game state (game.spectral + game.plies). At ~400KB per
// game this keeps the retained heap around 4MB — small enough that even
// a 15k-game broadcast corpus doesn't pressure the tab's memory after
// rapid-clicking through many games. The currently-active game is
// pinned so it never evicts even if a user clicks through many others.
const LRU_CAPACITY = 10;

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
 * Tunables
 * ------------------------------------------------------------------ */
// How many games to prefetch (manifest + NDJSON + spectralz) into OPFS
// before flipping the viewer to interactive. Covers the first few
// clickable rows plus game[0] which is eager-parsed on reveal. Phase-B
// background expansion fills in the rest.
const PREFETCH_GAMES = 10;

/* ------------------------------------------------------------------ *
 * Public entry point
 *
 * Three paths, chosen at runtime:
 *   1. FAST  — OPFS available + `.complete` marker for this cacheKey:
 *              read manifest from OPFS, skip libarchive entirely.
 *   2. EXPAND — OPFS available but cache cold/partial: libarchive
 *               prefetch of first N games (phase A, blocking) → reveal
 *               → single-pass extractFiles into OPFS (phase B,
 *               background). Emits 'gameReady' per entry, 'opfsComplete'
 *               when done.
 *   3. LEGACY — OPFS unavailable: original libarchive-per-extract path
 *               from v0.3.4. Still works, still has the stale-handle bug
 *               mitigated by the worker recycle in extractByPath.
 * ------------------------------------------------------------------ */
export async function loadCorpusFromFile(file, onProgress = () => {}) {
  const emit = throttleProgress(onProgress);
  const useOpfs = isOpfsAvailable();

  emit('decompress', `Opening ${file.name} (${formatBytes(file.size)})…`, 0.02);

  if (useOpfs) {
    try {
      const cacheKey = computeCacheKey(file);
      const opfsDir = await getCorpusDir(cacheKey);
      if (await opfsIsComplete(opfsDir)) {
        return await openFromOpfs({ file, opfsDir, emit });
      }
      return await openWithExpansion({ file, opfsDir, emit });
    } catch (e) {
      console.warn('OPFS path failed; falling back to legacy loader:', e);
      // Fall through to legacy path below.
    }
  }

  return await openLegacy({ file, emit });
}

/* ------------------------------------------------------------------ *
 * FAST path — everything on disk, libarchive never spawned.
 * ------------------------------------------------------------------ */
async function openFromOpfs({ file, opfsDir, emit }) {
  emit('manifest', 'Reading cached manifest…', 0.25);
  const manifestFile = await opfsRead(opfsDir, 'manifest.json');
  if (!manifestFile) throw new Error('cached manifest missing');
  const manifest = JSON.parse(await manifestFile.text());
  emit('manifest', `Manifest: ${manifest.games.length} games (cached)`, 0.35);

  augmentManifest(manifest);
  const variant = deriveVariant(manifest);

  const failed = await opfsReadFailed(opfsDir);
  const games = {};
  for (const g of manifest.games) {
    games[g.index] = {
      meta: g,
      pgn: null,
      plies: null,
      spectral: null,
      _ndjsonPath:   null,   // not needed on fast path
      _pgnPath:      null,
      _spectralPath: null,
      _loadPromise: null,
      opfsReady:  !failed.has(g.index),
      opfsFailed:  failed.has(g.index),
    };
  }

  const corpus = makeCorpusShell({ file, manifest, games, variant, opfsDir });

  const firstIndex = manifest.games[0].index;
  emit('spectral', `Decoding game ${firstIndex}…`, 0.7);
  await ensureGameData(corpus, firstIndex);
  emit('spectral', `Ready: game ${firstIndex}`, 0.95);
  emit('done', 'Ready (cached)', 1.0);

  // Nothing to expand; the table is fully unlocked immediately. Signal
  // this so app.js can clear any "expanding" affordance it might show.
  queueMicrotask(() => notify(corpus, 'opfsComplete'));
  return corpus;
}

/* ------------------------------------------------------------------ *
 * EXPAND path — phase A (blocking prefetch) then phase B (background).
 * ------------------------------------------------------------------ */
async function openWithExpansion({ file, opfsDir, emit }) {
  const handle = await openArchive(file);
  emit('decompress', `Archive indexed: ${handle.compressedMap.size} entries`, 0.18);

  const manifestRef = findEntry(handle.compressedMap, 'manifest.json');
  if (!manifestRef) throw new Error('manifest.json not found in archive');

  const baseDir = manifestRef.dir;
  // Persist manifest.json to OPFS on first sighting so the fast path
  // works next time even if phase B never finishes.
  const manifestFile = await manifestRef.file.extract();
  const manifestText = await manifestFile.text();
  const manifest = JSON.parse(manifestText);
  try { await opfsWrite(opfsDir, 'manifest.json', new TextEncoder().encode(manifestText)); }
  catch (e) { console.warn('OPFS manifest write failed:', e); }
  emit('manifest', `Manifest: ${manifest.games.length} games · run ${manifest.run_id || '—'}`, 0.22);

  const games = {};
  const totalGames = manifest.games.length;
  for (let i = 0; i < totalGames; i++) {
    const g = manifest.games[i];
    games[g.index] = {
      meta: g,
      pgn: null,
      plies: null,
      spectral: null,
      _ndjsonPath:   resolvePath(handle.compressedMap, baseDir, g.ndjson),
      _pgnPath:      resolvePath(handle.compressedMap, baseDir, g.pgn),
      _spectralPath: resolvePath(handle.compressedMap, baseDir, g.spectralz),
      _loadPromise: null,
      opfsReady: false,
      opfsFailed: false,
    };
    if ((i & 63) === 0 || i === totalGames - 1) {
      const frac = 0.22 + 0.08 * ((i + 1) / totalGames);
      emit('index', `Indexed ${i + 1}/${totalGames} games`, frac);
    }
  }

  augmentManifest(manifest);
  const variant = deriveVariant(manifest);

  const corpus = makeCorpusShell({ file, manifest, games, variant, opfsDir, handle });
  corpus._file = file;   // needed by legacy recycle path and phase-B reopen

  // Phase A: prefetch the first N games into OPFS so the viewer has
  // something clickable immediately. Any failure here is marked per-game
  // so phase B can skip it too.
  const prefetchTargets = manifest.games.slice(0, PREFETCH_GAMES);
  for (let k = 0; k < prefetchTargets.length; k++) {
    const g = prefetchTargets[k];
    const frac = 0.30 + 0.25 * ((k + 1) / prefetchTargets.length);
    emit('prefetch', `Caching game ${g.index} (${k + 1}/${prefetchTargets.length})…`, frac);
    try {
      await prefetchGameToOpfs(corpus, g);
      games[g.index].opfsReady = true;
    } catch (e) {
      console.warn(`prefetch failed for game ${g.index}:`, e);
      games[g.index].opfsFailed = true;
      try { await opfsAppendFailed(opfsDir, g.index); } catch { /* ignore */ }
    }
  }

  // Eager-parse game[0] so the viewer is immediately interactive.
  const firstIndex = manifest.games[0].index;
  emit('spectral', `Decoding game ${firstIndex}…`, 0.6);
  try {
    await ensureGameData(corpus, firstIndex);
  } catch (e) {
    // If game 0 can't be parsed even post-prefetch, let it surface to
    // the caller — the viewer has nothing to show.
    throw e;
  }
  emit('spectral', `Ready: game ${firstIndex}`, 0.95);
  emit('done', 'Ready (expanding in background)', 1.0);

  // Phase B: fire-and-forget. The viewer is already flipped to
  // state-viewer at this point; games land incrementally via gameReady.
  startBackgroundExpansion(corpus).catch((e) => {
    console.warn('background expansion failed:', e);
    notify(corpus, 'opfsComplete');
  });

  return corpus;
}

/* ------------------------------------------------------------------ *
 * LEGACY path — OPFS unavailable. Same as v0.3.4.
 * ------------------------------------------------------------------ */
async function openLegacy({ file, emit }) {
  const handle = await openArchive(file);
  emit('decompress', `Archive indexed: ${handle.compressedMap.size} entries`, 0.18);

  const manifestRef = findEntry(handle.compressedMap, 'manifest.json');
  if (!manifestRef) throw new Error('manifest.json not found in archive');

  const baseDir = manifestRef.dir;
  const manifestFile = await manifestRef.file.extract();
  const manifestText = await manifestFile.text();
  const manifest = JSON.parse(manifestText);
  emit('manifest', `Manifest: ${manifest.games.length} games · run ${manifest.run_id || '—'}`, 0.22);

  const games = {};
  const totalGames = manifest.games.length;
  for (let i = 0; i < totalGames; i++) {
    const g = manifest.games[i];
    games[g.index] = {
      meta: g,
      pgn: null,
      plies: null,
      spectral: null,
      _ndjsonPath:   resolvePath(handle.compressedMap, baseDir, g.ndjson),
      _pgnPath:      resolvePath(handle.compressedMap, baseDir, g.pgn),
      _spectralPath: resolvePath(handle.compressedMap, baseDir, g.spectralz),
      _loadPromise: null,
      // On the legacy path all games are "ready" in the UI sense — we
      // just extract them on demand through the libarchive worker.
      opfsReady: true,
      opfsFailed: false,
    };
    if ((i & 63) === 0 || i === totalGames - 1) {
      const frac = 0.22 + 0.18 * ((i + 1) / totalGames);
      emit('index', `Indexed ${i + 1}/${totalGames} games`, frac);
    }
  }

  augmentManifest(manifest);
  const variant = deriveVariant(manifest);

  const corpus = makeCorpusShell({ file, manifest, games, variant, handle });
  corpus._file = file;

  const firstIndex = manifest.games[0].index;
  emit('spectral', `Decoding game ${firstIndex}…`, 0.5);
  await ensureGameData(corpus, firstIndex);
  emit('spectral', `Ready: game ${firstIndex}`, 0.95);
  emit('done', 'Ready', 1.0);
  // Nothing to expand on the legacy path — signal immediate completion.
  queueMicrotask(() => notify(corpus, 'opfsComplete'));
  return corpus;
}

/* ------------------------------------------------------------------ *
 * Shared corpus-construction helpers
 * ------------------------------------------------------------------ */
function augmentManifest(manifest) {
  // Augment manifest rows with derived mean_FT for table sort convenience.
  for (const g of manifest.games) {
    g.mean_FT = (g.mean_F1 ?? 0) + (g.mean_F2 ?? 0) + (g.mean_F3 ?? 0);
  }
}

function deriveVariant(manifest) {
  // "chess" (default, backwards-compatible) or "othello". Older manifests
  // have no variant key; treat those as chess corpora unchanged.
  return (manifest.variant || manifest.game || 'chess').toLowerCase();
}

function makeCorpusShell({ file, manifest, games, variant, opfsDir = null, handle = null }) {
  const corpus = {
    manifest,
    games,
    variant,
    sourceName: file.name,
    sourceSize: file.size,
    _file: null,
    _handle: handle,
    _opfsDir: opfsDir,
    _opfsListeners: new Map(),   // event → Set<fn>
    _opfsComplete: false,
    _lru: null,
  };
  corpus._lru = createLRU(LRU_CAPACITY, (evictedIdx) => {
    const g = corpus.games[evictedIdx];
    if (!g) return;
    g.spectral = null;
    g.plies = null;
    g.pgn = null;
    g._loadPromise = null;
  });
  return corpus;
}

/** Minimal event emitter on the corpus object. Used for 'gameReady' and
 *  'opfsComplete' notifications that app.js wires up to row state. Keeps
 *  this plumbing out of the global app.js pub/sub so the loader stays
 *  self-contained and testable. */
export function onCorpusEvent(corpus, event, fn) {
  if (!corpus || !corpus._opfsListeners) return () => {};
  if (!corpus._opfsListeners.has(event)) corpus._opfsListeners.set(event, new Set());
  corpus._opfsListeners.get(event).add(fn);
  return () => corpus._opfsListeners.get(event)?.delete(fn);
}

function notify(corpus, event, payload) {
  if (!corpus || !corpus._opfsListeners) return;
  const set = corpus._opfsListeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try { fn(payload); } catch (e) { console.error(`corpus listener "${event}":`, e); }
  }
}

/* ------------------------------------------------------------------ *
 * Phase A: prefetch a single game's bytes into OPFS.
 *
 * Extracts NDJSON text and the gzipped spectralz blob (original bytes,
 * not decompressed) and writes them under games/<index>.ndjson and
 * games/<index>.spectralz.gz. Uses extractByPath so we inherit the
 * v0.3.4 worker-recycle behavior as defense-in-depth.
 * ------------------------------------------------------------------ */
async function prefetchGameToOpfs(corpus, gameMeta) {
  const game = corpus.games[gameMeta.index];
  if (!game) throw new Error(`unknown prefetch target ${gameMeta.index}`);
  const dir = corpus._opfsDir;

  if (game._ndjsonPath) {
    const ndjsonPath = `games/${gameMeta.index}.ndjson`;
    if (!(await opfsFileExists(dir, ndjsonPath))) {
      const file = await extractByPath(corpus, game._ndjsonPath, 'ndjson');
      const buf = await file.arrayBuffer();
      await opfsWrite(dir, ndjsonPath, new Uint8Array(buf));
    }
  }
  if (game._spectralPath) {
    const spectralPath = `games/${gameMeta.index}.spectralz.gz`;
    if (!(await opfsFileExists(dir, spectralPath))) {
      const file = await extractByPath(corpus, game._spectralPath, 'spectralz');
      const buf = await file.arrayBuffer();
      await opfsWrite(dir, spectralPath, new Uint8Array(buf));
    }
  }
}

/* ------------------------------------------------------------------ *
 * Phase B: background expansion of the whole archive into OPFS.
 *
 * Uses libarchive's single-pass extractFiles callback so we never touch
 * the per-entry handle that goes stale after ~25 extract() calls. We
 * open a FRESH archive instance so the prefetch-phase worker (which has
 * already seen N extractByPath calls) can stay unmolested; when phase B
 * finishes it terminates its own worker internally and we null the
 * fresh handle.
 * ------------------------------------------------------------------ */
async function startBackgroundExpansion(corpus) {
  if (!corpus || !corpus._file || !corpus._opfsDir) {
    notify(corpus, 'opfsComplete');
    if (corpus) corpus._opfsComplete = true;
    return;
  }
  const dir = corpus._opfsDir;
  // Build lookup: archive-path → gameIndex + kind. Using the entry's
  // path we know from the manifest — matching on basename is cheaper
  // than re-parsing the manifest on every callback.
  const byPath = new Map();   // archivePath → { gameIndex, kind, opfsPath }
  for (const g of corpus.manifest.games) {
    const gi = g.index;
    if (g.ndjson) {
      byPath.set(basename(g.ndjson),
        { gameIndex: gi, kind: 'ndjson', opfsPath: `games/${gi}.ndjson` });
    }
    if (g.spectralz) {
      byPath.set(basename(g.spectralz),
        { gameIndex: gi, kind: 'spectralz', opfsPath: `games/${gi}.spectralz.gz` });
    }
  }

  const totalEntries = byPath.size;
  let processed = 0;
  // Each game has two files (ndjson + spectralz). Track pair completion
  // so opfsReady flips only once both halves are on disk.
  const gameState = new Map();   // gameIndex → { haveNdjson, haveSpectral, failed }
  const ensureSlot = (gi) => {
    if (!gameState.has(gi)) gameState.set(gi, { haveNdjson: false, haveSpectral: false, failed: false });
    return gameState.get(gi);
  };
  // Seed from prefetch results so we don't double-write.
  for (const g of corpus.manifest.games) {
    const slot = ensureSlot(g.index);
    if (corpus.games[g.index].opfsReady) {
      slot.haveNdjson = true;
      slot.haveSpectral = true;
    }
  }

  let archive = null;
  try {
    const Archive = await importArchive();
    archive = await Archive.open(corpus._file);
    await new Promise((resolve, reject) => {
      archive.extractFiles((entry) => {
        try {
          handleExtractedEntry(entry, { byPath, gameState, corpus });
          processed++;
          notify(corpus, 'expandProgress', { processed, total: totalEntries });
        } catch (e) {
          console.warn('extractFiles callback:', e);
        }
      }).then(resolve, reject);
    });
  } catch (e) {
    console.warn('background extractFiles failed; marking unseen games as failed:', e);
    // Flag any games that didn't land as failed so the UI can quarantine
    // them instead of hanging on pending forever.
    for (const g of corpus.manifest.games) {
      const slot = gameState.get(g.index);
      const gd = corpus.games[g.index];
      if (gd && !gd.opfsReady && !gd.opfsFailed) {
        gd.opfsFailed = true;
        if (slot) slot.failed = true;
        try { await opfsAppendFailed(dir, g.index); } catch { /* ignore */ }
        notify(corpus, 'gameReady', { gameIndex: g.index, ready: false, failed: true });
      }
    }
  }

  // Promote any games whose pair is complete but weren't flipped during
  // the stream (e.g. entries arrived in interleaved order; we flip eagerly
  // inside handleExtractedEntry so this is usually a no-op).
  for (const [gi, slot] of gameState) {
    const gd = corpus.games[gi];
    if (!gd || gd.opfsReady || gd.opfsFailed) continue;
    if (slot.haveNdjson && slot.haveSpectral) {
      gd.opfsReady = true;
      notify(corpus, 'gameReady', { gameIndex: gi, ready: true, failed: false });
    }
  }

  try { await opfsMarkComplete(dir); } catch (e) { console.warn('markComplete:', e); }
  corpus._opfsComplete = true;
  notify(corpus, 'opfsComplete');
}

function handleExtractedEntry(entry, { byPath, gameState, corpus }) {
  if (!entry || !entry.file) return;
  // libarchive.js fires {file, path} where file.name is the basename.
  const name = entry.file.name || '';
  const slot = byPath.get(name);
  if (!slot) return;  // not a game file (could be manifest, README, etc.)
  const { gameIndex, kind, opfsPath } = slot;
  const gd = corpus.games[gameIndex];
  if (!gd) return;
  const state = gameState.get(gameIndex) ?? { haveNdjson: false, haveSpectral: false, failed: false };
  gameState.set(gameIndex, state);

  // If this game already failed earlier (prefetch error, validation fault),
  // don't try to rehydrate it — the row stays quarantined.
  if (gd.opfsFailed || state.failed) return;

  (async () => {
    try {
      const bytes = await entry.file.arrayBuffer();
      // Quick shape-validation before we commit bytes to disk, so a
      // corrupt game doesn't slip past the guard and blow up later in
      // parseNdjson / parseSpectralz under the ensureGameData reader.
      if (kind === 'spectralz') {
        validateSpectralzGzip(bytes);
      } else if (kind === 'ndjson') {
        // Non-strict — NDJSON parse is resilient (skips malformed lines),
        // but an empty or binary payload is a red flag.
        if (bytes.byteLength === 0) throw new Error('empty ndjson');
      }
      await opfsWrite(corpus._opfsDir, opfsPath, new Uint8Array(bytes));
      if (kind === 'ndjson')    state.haveNdjson  = true;
      if (kind === 'spectralz') state.haveSpectral = true;
      if (state.haveNdjson && state.haveSpectral && !gd.opfsReady) {
        gd.opfsReady = true;
        notify(corpus, 'gameReady', { gameIndex, ready: true, failed: false });
      }
    } catch (e) {
      console.warn(`game ${gameIndex} (${kind}) failed during expansion:`, e);
      state.failed = true;
      gd.opfsFailed = true;
      gd.opfsReady = false;
      try { await opfsAppendFailed(corpus._opfsDir, gameIndex); } catch { /* ignore */ }
      notify(corpus, 'gameReady', { gameIndex, ready: false, failed: true });
    }
  })();
}

/** Cheap sanity check on a gzipped spectralz blob. Catches obvious
 *  corruption (truncated / wrong magic) without running the full gunzip
 *  + parse pipeline on every entry. Real parse errors still surface
 *  when ensureGameData eventually reads the bytes. */
function validateSpectralzGzip(buf) {
  if (!buf || buf.byteLength < 10) throw new Error('spectralz too small');
  const head = new Uint8Array(buf, 0, 2);
  if (head[0] !== 0x1f || head[1] !== 0x8b) throw new Error('not a gzip stream');
}

function basename(p) {
  const s = String(p || '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i >= 0 ? s.slice(i + 1) : s;
}

/** Tear down a corpus: close the libarchive worker and drop parsed state.
 *  Idempotent — safe to call twice; the second call resolves to the first
 *  call's pending promise so a rapid reload-button mash doesn't double-close. */
export async function closeCorpus(corpus) {
  if (!corpus) return;
  if (corpus._closing) return corpus._closing;
  corpus._closing = (async () => {
    if (corpus._handle) {
      try {
        await corpus._handle.archive.close();
      } catch (e) {
        console.warn('archive.close:', e);
      }
      corpus._handle = null;
    }
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
  // Refuse to parse quarantined games so board.js / heatmap.js never
  // receive a corrupt payload. Callers already gate on opfsReady at the
  // row-click level; this is a second line of defense (programmatic
  // hash navigation, keyboard shortcuts, tests).
  if (game.opfsFailed) throw new Error(`game ${gameIndex} is quarantined`);
  if (game.plies && game.spectral) {
    corpus._lru.touch(gameIndex);
    return game;
  }
  if (game._loadPromise) return game._loadPromise;

  game._loadPromise = (async () => {
    // Prefer OPFS when present. If the game's been expanded, read the
    // original gzipped spectralz + NDJSON straight off disk — no
    // libarchive spin-up, no stale-handle risk.
    const dir = corpus._opfsDir;
    const ndjsonOpfsPath   = `games/${gameIndex}.ndjson`;
    const spectralOpfsPath = `games/${gameIndex}.spectralz.gz`;

    if (!game.plies) {
      let text = null;
      if (dir && await opfsFileExists(dir, ndjsonOpfsPath)) {
        const f = await opfsRead(dir, ndjsonOpfsPath);
        text = await f.text();
      } else if (game._ndjsonPath) {
        const ndjsonFile = await extractByPath(corpus, game._ndjsonPath, 'ndjson');
        text = await ndjsonFile.text();
        // Cache into OPFS so subsequent loads skip libarchive.
        if (dir) {
          try { await opfsWrite(dir, ndjsonOpfsPath, new TextEncoder().encode(text)); }
          catch (e) { console.warn('OPFS ndjson cache-write failed:', e); }
        }
      }
      if (text != null) game.plies = parseNdjson(text);
    }

    if (!game.spectral) {
      let buf = null;
      if (dir && await opfsFileExists(dir, spectralOpfsPath)) {
        const f = await opfsRead(dir, spectralOpfsPath);
        buf = await f.arrayBuffer();
      } else if (game._spectralPath) {
        const spectralFile = await extractByPath(corpus, game._spectralPath, 'spectralz');
        buf = await spectralFile.arrayBuffer();
        if (dir) {
          try { await opfsWrite(dir, spectralOpfsPath, new Uint8Array(buf)); }
          catch (e) { console.warn('OPFS spectralz cache-write failed:', e); }
        }
      }
      if (buf) {
        const decompressed = await gunzip(buf);
        const parsed = parseSpectralz(decompressed);
        game.spectral = enrichSpectral(parsed);
      }
    }

    corpus._lru.touch(gameIndex);
    return game;
  })();

  try {
    return await game._loadPromise;
  } catch (e) {
    game._loadPromise = null;    // allow retry
    // Quarantine on genuine data errors so the row state reflects the
    // failure. Stale-handle transient failures go through extractByPath's
    // recycle path above, so by the time we're here the data is actually
    // broken (gzip corrupt, wrong magic, truncated).
    if (isDataError(e)) {
      game.opfsFailed = true;
      game.opfsReady = false;
      if (corpus._opfsDir) {
        try { await opfsAppendFailed(corpus._opfsDir, gameIndex); } catch { /* ignore */ }
      }
      notify(corpus, 'gameReady', { gameIndex, ready: false, failed: true });
    }
    throw e;
  }
}

/** Heuristic: is this error a data-format problem (as opposed to a
 *  transient worker glitch)? Data errors → quarantine the game; transient
 *  errors → allow retry. We recognise a stale-archive handle explicitly
 *  (extractByPath already retries through a fresh worker) and treat
 *  everything else as a data error. False positives here just mean a
 *  bad game stays clickable one extra time; false negatives would let a
 *  truly broken game permanently lock out retries. */
function isDataError(e) {
  if (!e) return false;
  if (isStaleArchiveError(e)) return false;
  return true;
}

/* ------------------------------------------------------------------ *
 * Back-compat alias for any call site still using parseGameSpectral.
 * ------------------------------------------------------------------ */
export async function parseGameSpectral(corpus, gameIndex) {
  const g = await ensureGameData(corpus, gameIndex);
  return g.spectral;
}

/** Pull a single archive entry by path, retrying once through a fresh
 *  archive worker if libarchive.js's handle has gone stale.
 *
 *  After ~25-30 extracts against a large 7z (191 MB broadcast corpus),
 *  libarchive.js trips its own assertion: "PROGRAMMER ERROR: Function
 *  archive_read_support_filter_all invoked with invalid archive handle."
 *  The worker's WASM process aborts. Recycling — close old worker, spawn
 *  a fresh one from the retained File — fully resets the handle state at
 *  the cost of one archive re-walk (~200-400 ms).
 *
 *  The retry is one-shot. A second failure is propagated so the caller's
 *  catch (selectGame's try/catch, manifest load, etc.) still surfaces a
 *  real defect rather than looping forever. */
async function extractByPath(corpus, path, label) {
  const cf0 = corpus._handle.compressedMap.get(path);
  if (!cf0) throw new Error(`${label} entry missing: ${path}`);
  try {
    return await cf0.extract();
  } catch (e) {
    if (!isStaleArchiveError(e)) throw e;
    console.warn(`libarchive handle stale on ${label} extract; recycling worker…`);
    await recycleArchive(corpus);
    const cf1 = corpus._handle.compressedMap.get(path);
    if (!cf1) throw new Error(`${label} entry missing after recycle: ${path}`);
    return await cf1.extract();
  }
}

/** Heuristic match on libarchive.js's abort message + the downstream
 *  Emscripten "Aborted()" RuntimeError. Matching on message text is
 *  brittle but the library doesn't expose a typed error; restricting
 *  the retry to these two signatures keeps us from silently papering
 *  over unrelated failures. */
function isStaleArchiveError(e) {
  const msg = String(e && (e.message ?? e) || '');
  return msg.includes('invalid archive handle')
      || msg.includes('archive_read_support_filter_all')
      || msg.includes('Aborted()');
}

/** Close the archive worker and re-open from the retained File, then
 *  swap the fresh compressedMap onto corpus._handle in-place. Existing
 *  CompressedFile references held on game records are only paths (strings);
 *  the live CompressedFile objects are looked up via the Map per-extract,
 *  so swapping the Map transparently rebinds them. */
async function recycleArchive(corpus) {
  if (!corpus._file) throw new Error('cannot recycle archive: _file not retained');
  if (corpus._recycling) return corpus._recycling;
  corpus._recycling = (async () => {
    try {
      try { await corpus._handle.archive.close(); } catch (e) { console.warn('recycle close:', e); }
      const fresh = await openArchive(corpus._file);
      corpus._handle = fresh;
    } finally {
      corpus._recycling = null;
    }
  })();
  return corpus._recycling;
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
