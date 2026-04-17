/* Large-corpus smoke: reproduces the regression where, after the 191 MB
 * lichess_broadcast_2022-11.7z corpus finishes loading, clicking a new
 * row in the corpus table fails to switch games.
 *
 * Since libarchive.js (WASM + Web Worker) won't run under jsdom and no
 * 7z CLI is installed in the sandbox, we bypass loadCorpusFromFile and
 * manually construct a corpus object of the same shape that the loader
 * produces (see loader.js lines 141-161), then exercise the real
 * ensureGameData / LRU / virtual-table / closeCorpus code against it.
 *
 * One hand-verified 10-ply Ruy Lopez fixture is reused across every
 * synthetic game slot (see fixtures/legal-game.js). All FENs and SANs
 * are legal chess, so if future work routes these plies through a
 * real chess validator the fixture is already safe.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Break the app.js ↔ spectral.js ↔ charts.js ↔ board.js import cycle. At
// runtime the production entry point is app.js, so spectral.js is fully
// initialized before charts.js accesses CHANNELS. When a test enters via
// loader.js instead, spectral.js pauses on its `import ... from app.js`,
// app.js synchronously evaluates charts.js, and charts.js dereferences an
// uninitialized CHANNELS binding → "CHANNELS is not iterable". Stubbing
// app.js sidesteps the cycle entirely and also keeps the board/chart/
// overlay panels out of the smoke's blast radius.
vi.mock('../js/app.js', () => ({
  state: {},
  on:    () => () => {},
  set:   () => {},
  emit:  () => {},
  getActiveGame: () => null,
  APP_VERSION: 'smoke',
}));

const {
  ensureGameData,
  closeCorpus,
  parseNdjson,
  parseSpectralz,
} = await import('../js/loader.js');
const { createLRU }         = await import('../js/lru.js');
const { createVirtualTable } = await import('../js/virtual-table.js');
const {
  buildNdjson,
  buildSpectralzGzipBuffer,
  N_PLIES,
} = await import('./fixtures/legal-game.js');

// How many games to fabricate. 15k matches the real lichess_broadcast_2022-11
// scale (a month of top broadcasts); stays under 10s to build on a laptop.
const CORPUS_SIZE  = 15_000;
const LRU_CAPACITY = 10;   // mirrors loader.js

/* ------------------------------------------------------------------ *
 * Build a fake corpus whose _handle.compressedMap returns gzipped
 * spectralz bytes and NDJSON text on extract(). The fixture bytes are
 * built once and shared across all slots — each extract() call hands
 * back a fresh File view so the loader's async .text() / .arrayBuffer()
 * reads don't step on each other.
 * ------------------------------------------------------------------ */
function buildFakeCorpus(n = CORPUS_SIZE, { extractDelayMs } = {}) {
  const NDJSON_TEXT = buildNdjson();
  const SPECTRALZ_GZ = buildSpectralzGzipBuffer();

  // extractDelayMs(index, kind) → number of ms to sleep before extract()
  // resolves. Used by the race scenario to force non-FIFO completion.
  const delayFor = (i, k) => (extractDelayMs ? extractDelayMs(i, k) : 0);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const compressedMap = new Map();
  const manifestGames = new Array(n);
  const games = {};

  for (let i = 0; i < n; i++) {
    const ndjsonPath   = `games/g${i}.ndjson`;
    const spectralPath = `games/g${i}.spectralz.gz`;
    // Use plain objects with .text() / .arrayBuffer() so the smoke doesn't
    // depend on jsdom's File/Blob fidelity. Matches the surface actually
    // consumed by loader.js (see lines 102, 212, 220).
    compressedMap.set(ndjsonPath, {
      name: `g${i}.ndjson`,
      extract: async () => {
        const d = delayFor(i, 'ndjson');
        if (d > 0) await sleep(d);
        return {
          text: async () => NDJSON_TEXT,
          arrayBuffer: async () => new TextEncoder().encode(NDJSON_TEXT).buffer,
        };
      },
    });
    compressedMap.set(spectralPath, {
      name: `g${i}.spectralz.gz`,
      extract: async () => {
        const d = delayFor(i, 'spectralz');
        if (d > 0) await sleep(d);
        return {
          arrayBuffer: async () => SPECTRALZ_GZ,
          text: async () => { throw new Error('binary'); },
        };
      },
    });

    const meta = {
      index:    i,
      white:    `White${i}`,
      black:    `Black${i}`,
      result:   i % 3 === 0 ? '1-0' : (i % 3 === 1 ? '0-1' : '1/2-1/2'),
      white_elo: 2200 + (i % 400),
      black_elo: 2180 + (i % 400),
      n_plies:  N_PLIES,
      chaos_ratio: 0.5 + (i % 7) * 0.03,
      mean_A1:  0.1 + (i % 11) * 0.01,
      mean_F1:  0.2, mean_F2: 0.3, mean_F3: 0.4,
      event:    'Smoke',
      ndjson:     ndjsonPath,
      pgn:        null,
      spectralz:  spectralPath,
    };
    manifestGames[i] = meta;
    games[i] = {
      meta,
      pgn: null,
      plies: null,
      spectral: null,
      _ndjsonPath: ndjsonPath,
      _pgnPath: null,
      _spectralPath: spectralPath,
      _loadPromise: null,
    };
  }
  // Derived field (mirrors loader.js line 133).
  for (const g of manifestGames) g.mean_FT = g.mean_F1 + g.mean_F2 + g.mean_F3;

  const corpus = {
    manifest: { games: manifestGames, variant: 'chess', run_id: 'smoke' },
    games,
    variant: 'chess',
    sourceName: 'smoke.7z',
    sourceSize: 0,
    _handle: {
      archive: { close: async () => { /* no-op */ } },
      compressedMap,
    },
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

/* selectGame shim mirroring app.js:381. We don't import app.js because it
 * would drag in board.js / charts.js / chess-overlay.js whose listeners
 * aren't under test here and would require heavier mocking. The shim is
 * a faithful transcription of the code path under scrutiny — including
 * the sequence-token guard that drops stale completions. Keep this in
 * sync with the production selectGame. */
function makeSelector(corpus, vt) {
  let currentIndex = null;
  let token = 0;
  async function selectGame(index) {
    if (index === currentIndex) return;
    const mine = ++token;
    await ensureGameData(corpus, index);
    // Drop stale completion: a newer click bumped the token while we
    // awaited, so it owns the state mutation.
    if (mine !== token) return;
    if (currentIndex != null) corpus._lru.unpin(currentIndex);
    corpus._lru.pin(index);
    currentIndex = index;
    if (vt) vt.setActive(index);
  }
  return { selectGame, current: () => currentIndex };
}

function buildTableHarness() {
  const viewport = document.createElement('div');
  viewport.style.height = '300px';
  viewport.style.overflowY = 'auto';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  ['idx','white','black','res'].forEach((l) => {
    const th = document.createElement('th'); th.textContent = l; headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  const tbody = document.createElement('tbody');
  table.appendChild(thead); table.appendChild(tbody);
  viewport.appendChild(table);
  document.body.appendChild(viewport);
  const vt = createVirtualTable({
    viewport, tbody,
    keyFn: (g) => g.index,
    renderRow: (g) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `<td>${g.index}</td><td>${g.white}</td><td>${g.black}</td><td>${g.result}</td>`;
      return tr;
    },
  });
  return { viewport, tbody, vt };
}

/* ------------------------------------------------------------------ *
 * Scenarios
 * ------------------------------------------------------------------ */
describe('smoke: large corpus game switching', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('scenario 1: builds a 15k-game corpus and parses game[0] within budget', async () => {
    const t0 = performance.now();
    const corpus = buildFakeCorpus(CORPUS_SIZE);
    expect(Object.keys(corpus.games).length).toBe(CORPUS_SIZE);

    await ensureGameData(corpus, 0);
    expect(corpus.games[0].plies).toHaveLength(N_PLIES);
    expect(corpus.games[0].spectral.nPlies).toBe(N_PLIES);

    const dtMs = performance.now() - t0;
    // Fail the smoke (not just warn) if index build + first-game parse
    // blows past 10s — regressions in this phase would hide the bug
    // under "app didn't finish loading yet" timeouts.
    expect(dtMs).toBeLessThan(10_000);
  });

  it('scenario 2: sequential switch across 200 spread indices stays consistent', async () => {
    const corpus = buildFakeCorpus(CORPUS_SIZE);
    const { vt } = buildTableHarness();
    vt.setItems(corpus.manifest.games);
    const { selectGame, current } = makeSelector(corpus, vt);

    const step = Math.floor(CORPUS_SIZE / 200);
    for (let k = 0; k < 200; k++) {
      const idx = k * step;
      await selectGame(idx);
      expect(current()).toBe(idx);
      expect(corpus.games[idx].spectral).toBeTruthy();
      expect(corpus.games[idx].spectral.nPlies).toBe(N_PLIES);
      expect(vt.getActive()).toBe(idx);
      // LRU size never exceeds capacity + pinned set (we pin at most one)
      expect(corpus._lru.size()).toBeLessThanOrEqual(LRU_CAPACITY + 1);
    }
  });

  it('scenario 3a: overlapping selectGame calls with FIFO extract latency settle on last', async () => {
    // Uniform tiny delay — all extracts finish in issue order. Acts as a
    // control: if this fails we have a plumbing bug, not a race.
    const corpus = buildFakeCorpus(CORPUS_SIZE, {
      extractDelayMs: () => 1,
    });
    const { vt } = buildTableHarness();
    vt.setItems(corpus.manifest.games);
    const { selectGame, current } = makeSelector(corpus, vt);

    await selectGame(0);
    const targets = Array.from({ length: 20 }, (_, k) => (k + 1) * 137);
    await Promise.all(targets.map((idx) => selectGame(idx)));

    const last = targets[targets.length - 1];
    expect(current()).toBe(last);
    expect(vt.getActive()).toBe(last);
  });

  // Regression test for the last-click-loses race: overlapping clicks
  // whose backing extract() finishes out-of-order must still land on
  // the last-clicked index. Guard lives in selectGame's sequence token
  // (js/app.js, mirrored in makeSelector above).
  it('scenario 3b: non-FIFO extract latency still settles on the last-clicked index', async () => {
    // Inverted latency: the LATER the click, the FASTER it resolves. This
    // is the classic production pattern where a cold-cache click on an
    // earlier-requested game takes longer than a subsequent click on a
    // game whose data was already queued / cached closer.
    //
    // Under this pattern, selectGame's "await ensureGameData → unpin old
    // → pin new → set currentGameIndex" sequence (app.js:381-403) can
    // settle on the FIRST-issued index rather than the LAST-clicked one,
    // because the earlier promise resolves AFTER the later one and
    // overwrites currentGameIndex with a stale value.
    //
    // At small-corpus scale (the 10-game sweep, the 1-game PGN) extract
    // latency is ≈0 so all overlapping clicks FIFO-complete and the race
    // never fires. At 191 MB / 15k games the per-game extract takes
    // variable tens of ms, opening the window wide enough that every
    // rapid click sequence can land on the wrong game. This is why the
    // user sees the symptom only on the big broadcast corpus.
    const targets = Array.from({ length: 10 }, (_, k) => 1000 + k * 500);
    const delayByIndex = new Map();
    targets.forEach((idx, k) => {
      // Earliest issued = longest wait. 50ms → 5ms across 10 targets.
      delayByIndex.set(idx, 50 - k * 5);
    });

    const corpus = buildFakeCorpus(CORPUS_SIZE, {
      extractDelayMs: (i) => delayByIndex.get(i) ?? 0,
    });
    const { vt } = buildTableHarness();
    vt.setItems(corpus.manifest.games);
    const { selectGame, current } = makeSelector(corpus, vt);

    await selectGame(0);
    await Promise.all(targets.map((idx) => selectGame(idx)));

    const last = targets[targets.length - 1];
    if (current() !== last) {
      console.warn(
        `[smoke] race reproduced: last click was ${last}, ` +
        `currentIndex settled on ${current()} (stale completion won).`,
      );
    }
    // This is the assertion that SHOULD hold but currently doesn't.
    expect(current()).toBe(last);
    expect(vt.getActive()).toBe(last);
  });

  it('scenario 4: evict-and-resurrect produces a fresh spectral object reference', async () => {
    const corpus = buildFakeCorpus(CORPUS_SIZE);
    const { vt } = buildTableHarness();
    vt.setItems(corpus.manifest.games);
    const { selectGame } = makeSelector(corpus, vt);

    // Populate game[0] and snapshot its spectral object identity.
    await selectGame(0);
    const originalSpectralRef = corpus.games[0].spectral;
    expect(originalSpectralRef).toBeTruthy();

    // Now visit 40 other distinct games. With LRU capacity 10, game[0]
    // (which is unpinned as soon as we move to game[1]) must get evicted.
    for (let k = 1; k <= 40; k++) await selectGame(k);

    // game[0] should have been evicted and its fields nulled by the LRU
    // eviction callback (see loader.js lines 150-161).
    expect(corpus.games[0].spectral).toBeNull();

    // Re-selecting resurrects it — the spectral reference MUST differ
    // from the original, because enrichSpectral() builds a new object.
    // If it matches, the heatmap off-canvas identity cache (spectral.js
    // line 368, heatmap.offSpectralRef) will keep stale pixels.
    await selectGame(0);
    expect(corpus.games[0].spectral).toBeTruthy();
    expect(corpus.games[0].spectral).not.toBe(originalSpectralRef);
  });

  it('scenario 5: closeCorpus is safe to call twice concurrently', async () => {
    const corpus = buildFakeCorpus(100);
    await ensureGameData(corpus, 0);

    const a = closeCorpus(corpus);
    const b = closeCorpus(corpus);
    await expect(Promise.all([a, b])).resolves.toBeTruthy();
    expect(corpus._handle).toBeNull();
  });

  it('scenario 6: ensureGameData refuses a pre-quarantined (opfsFailed) game', async () => {
    const corpus = buildFakeCorpus(20);
    // Seed the quarantine flag the way phase-B would after a validation
    // fault during extractFiles — the UI quarantine path must hold even
    // without a click-time gate.
    corpus.games[5].opfsFailed = true;
    await expect(ensureGameData(corpus, 5)).rejects.toThrow(/quarantined/i);
    expect(corpus.games[5].spectral).toBeNull();
    expect(corpus.games[5].plies).toBeNull();
  });

  it('scenario 7: a parse-time failure marks opfsFailed and bans future loads', async () => {
    const corpus = buildFakeCorpus(5);
    // Replace game[2]'s spectralz extract with a corrupt blob (garbage
    // header, not a gzip stream). First call should reject with a parse
    // error; the ensureGameData error branch classifies it as a data
    // error and sets opfsFailed. The second call should reject with
    // the quarantine error (short-circuit before attempting extract).
    const corrupt = new Uint8Array([0x00, 0x00, 0x00, 0x00]).buffer;
    corpus._handle.compressedMap.set(corpus.games[2]._spectralPath, {
      name: 'g2.spectralz.gz',
      extract: async () => ({
        arrayBuffer: async () => corrupt,
        text: async () => { throw new Error('binary'); },
      }),
    });
    await expect(ensureGameData(corpus, 2)).rejects.toThrow();
    expect(corpus.games[2].opfsFailed).toBe(true);
    expect(corpus.games[2].spectral).toBeNull();
    // Second attempt short-circuits: "quarantined" wording comes from
    // the opfsFailed guard at the top of ensureGameData.
    await expect(ensureGameData(corpus, 2)).rejects.toThrow(/quarantined/i);
  });

  it('fixture sanity: NDJSON and spectralz round-trip through production parsers', async () => {
    const ndjson = buildNdjson();
    const plies = parseNdjson(ndjson);
    expect(plies).toHaveLength(N_PLIES);
    expect(plies[0].ply).toBe(0);
    expect(plies.at(-1).ply).toBe(N_PLIES - 1);
    // All FENs present and non-empty (guard against a silent stringify).
    for (const p of plies) expect(typeof p.fen === 'string' && p.fen.length > 10).toBe(true);

    const gz = buildSpectralzGzipBuffer();
    const decompressed = await new Response(
      new Response(gz).body.pipeThrough(new DecompressionStream('gzip')),
    ).arrayBuffer();
    const parsed = parseSpectralz(decompressed);
    expect(parsed.nPlies).toBe(N_PLIES);
    expect(parsed.dim).toBe(640);
  });
});
