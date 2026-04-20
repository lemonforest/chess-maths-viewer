/* app.js — application entry point.
 *
 * Owns the single source of truth for runtime state, the pub/sub bus,
 * keyboard shortcuts, URL hash sync, and panel wiring. Imported first
 * by index.html as a module; pulls in the rest of the JS lazily.
 */

import { loadCorpusFromFile, ensureGameData, closeCorpus, formatBytes } from './loader.js';
import {
  CHANNELS,
  CHANNEL_BY_ID,
  initHeatmap,
  refreshHeatmap,
} from './spectral.js';
import { initChart, refreshChart } from './charts.js';
import { initBoard, refreshBoard, stopAutoplay } from './board.js';
import { createVirtualTable } from './virtual-table.js';

/** Canonical app version for programmatic consumers (tests, telemetry).
 *  The visible footer stamp is sourced from #version-tag in index.html so
 *  a stale-cached app.js can't downgrade the displayed version after a
 *  fresh HTML load. Keep this, the HTML tag, README, and package.json in
 *  sync on every release. */
export const APP_VERSION = 'v0.7.0';

/* ------------------------------------------------------------------ *
 * State store
 * ------------------------------------------------------------------ */
export const state = {
  corpus: null,
  currentGameIndex: 1,
  currentPly: 0,
  activeChannels: new Set(['A1', 'FT']),
  heatmapView: 'A1',
  autoplay: { running: false, intervalMs: 500 },
  evalOverlay: true,
  boardOverlay: false,       // project the current heatmap channel onto the board
  overlayTransform: 'abs',   // 'abs' | 'delta' | 'log' | 'z' — perceptual mode for the overlay
  plainBoard: false,         // flatten the checker pattern so overlay tints read cleanly

  // Fiber-norm overlay: a static (non-ply-dependent) rank-3 fiber field
  // painted onto the 8x8 surface. Mutually exclusive with boardOverlay
  // at the rendering level (they share the board squares); both state
  // flags live here so the UI buttons can track pressed state
  // independently.
  fiberOverlay: false,       // show the fiber-norm overlay?
  fiberPiece:   'N',         // 'N' | 'B' | 'R' | 'Q' | 'K'
  fiberMode:    'gradient',  // 'gradient' | 'discrete'
  fiberCmap:    'viridis',   // 'viridis' | 'diverging'

  chartScale: 'z',
  pendingHash: null,        // { game, ply } from URL when corpus not loaded yet
  tableSort: { key: 'index', dir: 'asc' },
};

const listeners = new Map(); // event → Set<fn>

export function on(event, fn) {
  if (!listeners.has(event)) listeners.set(event, new Set());
  listeners.get(event).add(fn);
  return () => listeners.get(event).delete(fn);
}

export function emit(event) {
  const set = listeners.get(event);
  if (!set) return;
  for (const fn of set) {
    try { fn(state); } catch (e) { console.error(`listener for "${event}":`, e); }
  }
}

/** Apply a partial state update and emit events for whatever changed.
 *  Emits both the canonical key name and short aliases (game, ply). */
export function set(patch) {
  const changed = new Set();
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === 'object') {
      state[k] = v;          // always treat object updates as changes
      changed.add(k);
    } else if (state[k] !== v) {
      state[k] = v;
      changed.add(k);
    }
  }

  // Bound enforcement on ply
  if (changed.has('currentPly')) {
    const game = getActiveGame();
    if (game) {
      const n = game.spectral?.nPlies ?? game.plies?.length ?? 0;
      if (n > 0) {
        state.currentPly = Math.max(0, Math.min(n - 1, state.currentPly | 0));
      }
    }
  }

  // Aliases for ergonomic subscribers
  const aliases = new Set();
  if (changed.has('currentGameIndex')) aliases.add('game');
  if (changed.has('currentPly'))       aliases.add('ply');

  for (const k of changed) emit(k);
  for (const k of aliases) emit(k);
  if (changed.size) syncHash();
}

export function getActiveGame() {
  if (!state.corpus) return null;
  return state.corpus.games[state.currentGameIndex] || null;
}

/* ------------------------------------------------------------------ *
 * URL hash sync (#game=3&ply=42)
 * ------------------------------------------------------------------ */
function syncHash() {
  if (!state.corpus) return;
  const params = new URLSearchParams();
  params.set('game', state.currentGameIndex);
  params.set('ply',  state.currentPly);
  params.set('view', state.heatmapView);
  if (state.activeChannels.size) {
    params.set('ch', [...state.activeChannels].join(','));
  }
  if (state.chartScale !== 'z') params.set('scale', state.chartScale);
  if (state.overlayTransform && state.overlayTransform !== 'abs') {
    params.set('tx', state.overlayTransform);
  }
  if (state.fiberOverlay) {
    params.set('fiber', [state.fiberPiece, state.fiberMode, state.fiberCmap].join(','));
  }
  history.replaceState(null, '', '#' + params.toString());
}

function readHash() {
  const h = location.hash.replace(/^#/, '');
  if (!h) return null;
  const params = new URLSearchParams(h);
  return {
    game: params.get('game') ? parseInt(params.get('game'), 10) : null,
    ply:  params.get('ply')  ? parseInt(params.get('ply'),  10) : null,
    view: params.get('view') || null,
    channels: params.get('ch')   ? params.get('ch').split(',').filter(Boolean) : null,
    scale:    params.get('scale') || null,
    transform: params.get('tx') || null,
    fiber:    params.get('fiber') || null,
  };
}

/* ------------------------------------------------------------------ *
 * Loading flow
 * ------------------------------------------------------------------ */
/** Path to the bundled corpus index (generated by
 *  scripts/build-dataset-index.mjs — rerun after adding a .7z). */
const DATASET_INDEX_PATH = './dataset/index.json';

/** Coerce any thrown value into a human-readable string. Plain objects with
 *  no useful toString() otherwise render as "[object Object]" in alert(). */
function formatErr(e) {
  if (e == null) return 'unknown error';
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message || String(e);
  if (typeof e === 'object') {
    if (typeof e.message === 'string' && e.message) return e.message;
    try { return JSON.stringify(e); } catch { /* fallthrough */ }
  }
  return String(e);
}

/** Fetch a bundled .7z from the dataset/ folder and feed it through startLoad. */
async function loadBundledCorpus(filename) {
  const url = new URL(`./dataset/${filename}`, document.baseURI).href;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${filename}`);
  const blob = await resp.blob();
  const file = new File([blob], filename, {
    type: 'application/x-7z-compressed',
    lastModified: Date.now(),
  });
  return startLoad(file);
}

/** Fetch dataset/index.json and render one card per entry into the
 *  landing-screen BUNDLED CORPORA section. Silently no-ops if the
 *  index is missing (e.g. site served without running the build
 *  script, or dataset/ empty). */
async function renderDatasetList() {
  const section = document.getElementById('dataset-section');
  const list    = document.getElementById('dataset-list');
  const count   = document.getElementById('dataset-count');
  if (!section || !list) return;

  let index;
  try {
    const resp = await fetch(DATASET_INDEX_PATH, { cache: 'no-cache' });
    if (!resp.ok) {
      // 404 is the expected "no bundled corpora" case — stay silent.
      if (resp.status !== 404) console.warn(`dataset index: HTTP ${resp.status}`);
      return;
    }
    index = await resp.json();
  } catch (e) {
    console.warn('dataset index:', formatErr(e));
    return;
  }
  const corpora = Array.isArray(index?.corpora) ? index.corpora : [];
  if (corpora.length === 0) return;

  list.innerHTML = '';
  for (const c of corpora) {
    const li = document.createElement('li');
    li.className = 'dataset-card';
    li.innerHTML = `
      <button type="button" class="dataset-card-btn" data-file="${escape(c.file)}">
        <span class="dataset-card-arrow" aria-hidden="true">↳</span>
        <span class="dataset-card-body">
          <span class="dataset-card-title">${escape(c.title || c.file)}</span>
          ${c.subtitle ? `<span class="dataset-card-sub mono">${escape(c.subtitle)}</span>` : ''}
        </span>
        <span class="dataset-card-meta mono dim">${escape(c.size_human || '')}</span>
      </button>
    `;
    const btn = li.querySelector('.dataset-card-btn');
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      btn.disabled = true;
      try {
        await loadBundledCorpus(c.file);
      } catch (err) {
        alert(`Could not load ${c.file}: ${formatErr(err)}`);
      } finally {
        // Re-enable so the card is clickable again after the user hits
        // "Load corpus" (reload) to return to the landing screen. The
        // disabled state during load still guards against accidental
        // double-clicks while the card is still on screen.
        btn.disabled = false;
      }
    });
    list.appendChild(li);
  }
  count.textContent = `${corpora.length} bundled`;
  section.hidden = false;
}

async function startLoad(file) {
  document.body.className = 'state-loading';
  document.getElementById('loading-filename').textContent = file.name;
  document.getElementById('loading-filesize').textContent = formatBytes(file.size);
  const log = document.getElementById('loading-log');
  log.innerHTML = '';
  document.getElementById('progress-fill').style.width = '0%';

  const seenPhases = new Map();
  const onProgress = ({ phase, msg, fraction }) => {
    document.getElementById('progress-fill').style.width = (Math.max(0, Math.min(1, fraction)) * 100) + '%';
    let li = seenPhases.get(phase);
    if (!li) {
      li = document.createElement('li');
      log.appendChild(li);
      seenPhases.set(phase, li);
    }
    li.textContent = msg;
    if (phase === 'done') li.classList.add('done');
  };

  try {
    const corpus = await loadCorpusFromFile(file, onProgress);
    state.corpus = corpus;

    // Apply pending hash (or default)
    const hash = state.pendingHash || readHash();
    state.pendingHash = null;
    if (hash?.game && corpus.games[hash.game]) {
      state.currentGameIndex = hash.game;
    } else {
      state.currentGameIndex = corpus.manifest.games[0].index;
    }
    if (hash?.view)     state.heatmapView = hash.view;
    if (hash?.channels) state.activeChannels = new Set(hash.channels);
    if (hash?.scale)    state.chartScale = hash.scale;
    if (hash?.transform) state.overlayTransform = hash.transform;
    if (hash?.fiber) {
      const [p, m, c] = hash.fiber.split(',');
      if (['N','B','R','Q','K'].includes(p))          state.fiberPiece = p;
      if (['gradient','discrete'].includes(m))         state.fiberMode  = m;
      if (['viridis','diverging'].includes(c))         state.fiberCmap  = c;
      state.fiberOverlay = true;
    }

    // If selected game wasn't pre-parsed (only game[0] is eager), parse now.
    // This guarantees plies + spectral are populated before the viewer reveals.
    await ensureGameData(corpus, state.currentGameIndex);
    corpus._lru.pin(state.currentGameIndex);

    if (hash?.ply != null) state.currentPly = hash.ply;
    else                   state.currentPly = 0;

    // Reveal viewer
    document.body.className = 'state-viewer';

    // Render initial state
    renderCorpusTable();
    renderChainBreadcrumb();
    setCorpusMeta();

    // Defer the panel-emit kick to the next animation frame so the
    // browser has performed a full layout pass after the body class
    // change. Otherwise renderChart/renderHeatmap measure the SVG/canvas
    // before the grid has settled and draw to a stale viewBox — which
    // looks like a squished chart until any later interaction triggers
    // a re-render at the correct size.
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

    // Notify panels (they were registered for events but we want a kick)
    emit('game');
    emit('heatmapView');
    emit('activeChannels');
    emit('chartScale');
    emit('evalOverlay');
    emit('overlayTransform');
    // Kick the fiber-overlay subscribers once so initial control
    // highlights and helper text land in the right state without
    // waiting for the user to click.
    emit('fiberPiece');
    emit('fiberMode');
    emit('fiberCmap');
    emit('fiberOverlay');
    emit('ply');
    syncHash();
  } catch (err) {
    console.error('corpus load failed:', err);
    const li = document.createElement('li');
    li.className = 'err';
    li.textContent = 'Failed: ' + formatErr(err);
    log.appendChild(li);
    setTimeout(() => { document.body.className = 'state-landing'; }, 3500);
  }
}

/* ------------------------------------------------------------------ *
 * Corpus table
 *
 * Rendered via a virtual scroller so sort and scroll stay snappy even at
 * 15k rows (a month of Lichess). Only ~35 <tr>s live in the DOM at once
 * regardless of corpus size; the scrollbar reflects the full list via
 * two tall spacer rows above and below the visible window.
 * ------------------------------------------------------------------ */
let corpusTable = null;    // virtual-table handle, populated in initCorpusTable

function initCorpusTable() {
  const tbody = document.querySelector('#game-table tbody');
  const viewport = document.getElementById('game-table-host');
  corpusTable = createVirtualTable({
    viewport,
    tbody,
    keyFn: (g) => g.index,
    overscan: 10,
    renderRow: (g) => {
      const tr = document.createElement('tr');
      tr.dataset.index = g.index;
      const gameRec = state.corpus?.games?.[g.index];
      if (gameRec?.loadFailed) {
        tr.dataset.state = 'failed';
        tr.title = 'Game data is corrupt — skipped';
      }
      tr.innerHTML = `
        <td>${g.index}</td>
        <td>${escape(g.white || '—')}</td>
        <td>${escape(g.black || '—')}</td>
        <td class="${resultClass(g.result)}">${escape(g.result || '—')}</td>
        <td class="num">${g.white_elo || ''}</td>
        <td class="num">${g.black_elo || ''}</td>
        <td class="num">${g.n_plies}</td>
        <td class="num">${formatChi(g.chaos_ratio)}</td>
        <td class="num">${formatScalar(g.mean_A1)}</td>
        <td class="num">${formatScalar(g.mean_FT)}</td>
        <td class="event">${escape(g.event || '')}</td>
      `;
      tr.addEventListener('click', () => {
        const rec = state.corpus?.games?.[g.index];
        if (!rec || rec.loadFailed) return;     // quarantined; click is a no-op
        selectGame(g.index);
      });
      return tr;
    },
  });
}

function renderCorpusTable() {
  if (!corpusTable) initCorpusTable();
  corpusTable.setItems(sortedGames());
  corpusTable.setActive(state.currentGameIndex);
  updateSortIndicators();
  refreshCorpusNav();
}

function updateSortIndicators() {
  const headers = document.querySelectorAll('#game-table th[data-sort]');
  for (const th of headers) {
    th.classList.remove('sort-asc', 'sort-desc');
    if (th.dataset.sort === state.tableSort.key) {
      th.classList.add(state.tableSort.dir === 'asc' ? 'sort-asc' : 'sort-desc');
    }
  }
}

function sortedGames() {
  const games = [...state.corpus.manifest.games];
  const { key, dir } = state.tableSort;
  const collator = new Intl.Collator();
  games.sort((a, b) => {
    const va = a[key]; const vb = b[key];
    let cmp;
    if (typeof va === 'number' || typeof vb === 'number') {
      cmp = (va ?? -Infinity) - (vb ?? -Infinity);
    } else {
      cmp = collator.compare(String(va ?? ''), String(vb ?? ''));
    }
    return dir === 'asc' ? cmp : -cmp;
  });
  return games;
}

// Monotonic sequence token for selectGame. Each click bumps it; a stale
// completion whose token no longer matches is dropped so it can't
// overwrite state.currentGameIndex with a racing earlier click's index.
// Needed because on the 15k-game lichess broadcast corpus per-game
// extract latency varies enough that overlapping clicks can resolve
// out-of-order (see tests-js/smoke-large-corpus.test.js scenario 3b).
let _selectGameToken = 0;

async function selectGame(index) {
  if (index === state.currentGameIndex) return;
  // Refuse quarantined games so keyboard / URL / nav-button paths can't
  // route around the row-click gate and hand garbage to the viewer.
  const rec = state.corpus?.games?.[index];
  if (!rec || rec.loadFailed) return;
  const token = ++_selectGameToken;
  // Stop autoplay synchronously before we swap games. The board panel also
  // stops autoplay in its 'game' subscriber, but that runs after set() emits
  // — racing with any stale timer tick that fires between selectGame and the
  // emit. Calling stopAutoplay first removes the ordering dependency.
  stopAutoplay();
  setCorpusSwitching(true);
  // Lazy-parse NDJSON + spectral on demand. ensureGameData coalesces
  // concurrent calls on the same index and touches the LRU.
  try {
    await ensureGameData(state.corpus, index);
  } catch (e) {
    console.error('game data load failed:', e);
    if (token === _selectGameToken) setCorpusSwitching(false);
    return;
  }
  // If a newer click has bumped the token while we were awaiting, drop
  // this completion — the later click is already in flight and will run
  // the state mutation itself. This prevents the last-click-loses race.
  if (token !== _selectGameToken) return;
  // Repin: active game must never evict even if many others are clicked.
  state.corpus._lru.unpin(state.currentGameIndex);
  state.corpus._lru.pin(index);

  set({ currentGameIndex: index, currentPly: 0 });
  // Virtualizer updates the .active class on currently-rendered rows
  // only — O(visible) rather than O(corpus).
  if (corpusTable) corpusTable.setActive(index);
  renderChainBreadcrumb();
  setCorpusSwitching(false);
}

/** Toggle the indeterminate progress indicator in the CORPUS title bar.
 *  Mirrors, in spirit, the initial corpus-load progress bar — same
 *  cool→warm gradient — so the user has a consistent visual vocabulary
 *  for "data is being fetched/parsed". No-op when the element isn't in
 *  the DOM (e.g. under tests). */
function setCorpusSwitching(on) {
  const el = document.getElementById('corpus-switching');
  if (!el) return;
  el.classList.toggle('active', !!on);
}


function resultClass(r) {
  if (r === '1-0') return 'result-W';
  if (r === '0-1') return 'result-B';
  return 'result-D';
}

function formatChi(v) {
  return Number.isFinite(v) ? v.toFixed(2) : '—';
}

function formatScalar(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1000) return v.toExponential(1);
  if (a >= 10)   return v.toFixed(1);
  return v.toFixed(2);
}

function escape(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ------------------------------------------------------------------ *
 * Chain breadcrumb
 * ------------------------------------------------------------------ */
function renderChainBreadcrumb() {
  const host = document.getElementById('chain-breadcrumb');
  host.innerHTML = '';
  const games = state.corpus.manifest.games;
  if (games.length < 2) return;

  // Detect a chain: each adjacent pair shares a player.
  const chain = [];
  for (let i = 0; i < games.length - 1; i++) {
    const a = games[i], b = games[i + 1];
    const shared = [a.white, a.black].find((p) => p === b.white || p === b.black);
    if (!shared) return; // not a chain → skip breadcrumb entirely
    chain.push({ a, b, shared });
  }

  // Build a flat ordered list of unique player labels traversing the chain
  const path = [];
  const first = games[0];
  // Start with both players of the first game (the "non-shared" first, then shared)
  const firstShared = chain[0].shared;
  const firstOther = (first.white === firstShared) ? first.black : first.white;
  path.push(firstOther);
  path.push(firstShared);

  for (const link of chain) {
    const next = link.b;
    const nextOther = (next.white === link.shared) ? next.black : next.white;
    path.push(nextOther);
  }

  const activeGame = state.corpus.manifest.games.find((g) => g.index === state.currentGameIndex);
  const activeSet = new Set([activeGame?.white, activeGame?.black].filter(Boolean));

  // Cap the rendered breadcrumb so a hypothetical 15k-long chain
  // doesn't blow up the header. Always keep the first, last, and
  // active-adjacent nodes visible; elide the rest with an ellipsis.
  const MAX_VISIBLE = 8;
  let visible;
  if (path.length <= MAX_VISIBLE) {
    visible = path.map((p, i) => ({ p, i, kind: 'node' }));
  } else {
    const activeIdx = path.findIndex((p) => activeSet.has(p));
    const anchor = activeIdx >= 0 ? activeIdx : 0;
    // Window of ~6 nodes centered on the active player, always keeping
    // the chain's head and tail pinned.
    const halfWin = 2;
    const winStart = Math.max(1, anchor - halfWin);
    const winEnd   = Math.min(path.length - 2, anchor + halfWin);
    visible = [];
    visible.push({ p: path[0], i: 0, kind: 'node' });
    if (winStart > 1) visible.push({ kind: 'ellipsis' });
    for (let i = winStart; i <= winEnd; i++) visible.push({ p: path[i], i, kind: 'node' });
    if (winEnd < path.length - 2) visible.push({ kind: 'ellipsis' });
    visible.push({ p: path[path.length - 1], i: path.length - 1, kind: 'node' });
  }

  for (let v = 0; v < visible.length; v++) {
    if (v > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = '→';
      host.appendChild(arrow);
    }
    const entry = visible[v];
    const node = document.createElement('span');
    node.className = 'node' + (entry.kind === 'ellipsis' ? ' ellipsis' : '');
    if (entry.kind === 'ellipsis') {
      node.textContent = '…';
    } else {
      if (activeSet.has(entry.p)) node.classList.add('active');
      node.textContent = entry.p;
    }
    host.appendChild(node);
  }
}

function setCorpusMeta() {
  const meta = document.getElementById('corpus-meta');
  const m = state.corpus.manifest;
  if (!meta) return;
  meta.textContent = `${m.games.length} games · ${state.corpus.sourceName}`;
}

/* ------------------------------------------------------------------ *
 * Drop zone + browse + drag/drop
 * ------------------------------------------------------------------ */
function setupDropZone() {
  const zone   = document.getElementById('drop-zone');
  const card   = zone.querySelector('.drop-card');
  const input  = document.getElementById('file-input');
  const browse = document.getElementById('browse-btn');

  card.addEventListener('click', (e) => {
    if (e.target === browse) return;
    input.click();
  });
  browse.addEventListener('click', (e) => {
    e.stopPropagation();
    input.click();
  });
  input.addEventListener('change', () => {
    if (input.files && input.files[0]) startLoad(input.files[0]);
  });

  // Whole-window drag/drop overlay
  for (const ev of ['dragenter', 'dragover']) {
    window.addEventListener(ev, (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      card.classList.add('dragover');
    });
  }
  for (const ev of ['dragleave', 'drop']) {
    window.addEventListener(ev, (e) => {
      e.preventDefault();
      card.classList.remove('dragover');
    });
  }
  window.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files || !e.dataTransfer.files[0]) return;
    const file = e.dataTransfer.files[0];
    if (!/\.7z$/i.test(file.name)) {
      alert('Please drop a .7z spectral corpus.');
      return;
    }
    startLoad(file);
  });

  // Reload button — tear down the libarchive worker so we don't leak it
  // across corpora. closeCorpus is async; kick the UI state change
  // immediately and let the worker teardown finish in the background.
  // Disable the button while teardown is pending so a rapid mash can't
  // start a second teardown against an already-detached handle.
  const reloadBtn = document.getElementById('reload-btn');
  reloadBtn.addEventListener('click', () => {
    const prev = state.corpus;
    state.corpus = null;
    document.body.className = 'state-landing';
    if (!prev) return;
    reloadBtn.disabled = true;
    closeCorpus(prev)
      .catch((e) => console.warn('closeCorpus:', formatErr(e)))
      .finally(() => { reloadBtn.disabled = false; });
  });

  // Bundled-corpora cards are rendered in init() → renderDatasetList()
  // from dataset/index.json (generated by scripts/build-dataset-index.mjs).

  // Pending hash note
  const hash = readHash();
  if (hash?.game != null) {
    state.pendingHash = hash;
    const note = document.getElementById('hash-pending');
    note.hidden = false;
    note.textContent = `Load a corpus to view game ${hash.game}, ply ${hash.ply ?? 0}`;
  }
}

function hasFiles(e) {
  if (!e.dataTransfer) return false;
  return [...(e.dataTransfer.types || [])].includes('Files');
}

/* ------------------------------------------------------------------ *
 * Keyboard
 * ------------------------------------------------------------------ */
function setupKeyboard() {
  window.addEventListener('keydown', (e) => {
    if (document.body.className !== 'state-viewer') return;
    if (isTypingTarget(e.target)) return;

    const game = getActiveGame();
    if (!game) return;
    const n = game.spectral?.nPlies ?? game.plies?.length ?? 0;
    if (n <= 0) return;

    switch (e.key) {
      case 'ArrowLeft':
        set({ currentPly: Math.max(0, state.currentPly - 1) });
        e.preventDefault();
        return;
      case 'ArrowRight':
        set({ currentPly: Math.min(n - 1, state.currentPly + 1) });
        e.preventDefault();
        return;
      case 'Home':
        set({ currentPly: 0 });
        e.preventDefault();
        return;
      case 'End':
        set({ currentPly: n - 1 });
        e.preventDefault();
        return;
      case ' ':
        // Let native space-on-button activate when a button is focused;
        // intercept only when focus is on the body / a non-button element.
        if (document.activeElement && document.activeElement.tagName === 'BUTTON') return;
        document.querySelector('button[data-action="play"]').click();
        e.preventDefault();
        return;
      case 'Escape':
        if (state.autoplay.running) {
          document.querySelector('button[data-action="play"]').click();
        }
        e.preventDefault();
        return;
    }

    // Game number shortcuts (1–9, 0=10). Only reached if no switch case fired.
    if (/^[0-9]$/.test(e.key)) {
      const wantIdx = e.key === '0' ? 10 : parseInt(e.key, 10);
      const exists  = state.corpus.games[wantIdx];
      if (exists) {
        selectGame(wantIdx);
        e.preventDefault();
      }
    }
  });
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable;
}

/* ------------------------------------------------------------------ *
 * Table header sorting
 * ------------------------------------------------------------------ */
function setupTableSorting() {
  document.querySelectorAll('#game-table th[data-sort]').forEach((th) => {
    if (!th.classList.contains('sortable')) return;
    th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (state.tableSort.key === key) {
        state.tableSort.dir = state.tableSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        state.tableSort.key = key;
        state.tableSort.dir = key === 'index' ? 'asc' : 'desc';
      }
      renderCorpusTable();
    });
  });
}

/* ------------------------------------------------------------------ *
 * Corpus nav — step / jump through the game list
 *
 * Walks games in the table's current sort order (not raw index) so
 * ◄/► tracks what the user actually sees. Clamped at the ends — no
 * wrap-around, because a 15k-game corpus with accidental wrap would
 * be a navigation foot-gun.
 * ------------------------------------------------------------------ */
/** Is game index clickable right now? */
function isGameReady(idx) {
  const rec = state.corpus?.games?.[idx];
  return !!(rec && !rec.loadFailed);
}

function stepGame(delta) {
  if (!state.corpus) return;
  const sorted = sortedGames();
  if (!sorted.length) return;
  const pos = sorted.findIndex((g) => g.index === state.currentGameIndex);
  const from = pos >= 0 ? pos : 0;
  const dir = delta > 0 ? 1 : -1;
  // Walk past pending/failed siblings so the user always lands on a
  // clickable game. Stops at the end of the sorted list either way.
  let to = from;
  for (let i = 0; i < Math.abs(delta); i++) {
    let next = to + dir;
    while (next >= 0 && next < sorted.length && !isGameReady(sorted[next].index)) {
      next += dir;
    }
    if (next < 0 || next >= sorted.length) break;
    to = next;
  }
  if (to === from) return;
  const target = sorted[to].index;
  selectGame(target);
  if (corpusTable) corpusTable.scrollToKey(target);
}

function jumpGame(where) {
  if (!state.corpus) return;
  const sorted = sortedGames();
  if (!sorted.length) return;
  const readyList = where === 'first' ? sorted : [...sorted].reverse();
  const target = readyList.find((g) => isGameReady(g.index))?.index;
  if (target == null || target === state.currentGameIndex) return;
  selectGame(target);
  if (corpusTable) corpusTable.scrollToKey(target);
}

function refreshCorpusNav() {
  const host = document.querySelector('.corpus-nav');
  if (!host) return;
  const n = state.corpus?.manifest?.games?.length ?? 0;
  if (n === 0) {
    host.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    return;
  }
  const sorted = sortedGames();
  const pos = sorted.findIndex((g) => g.index === state.currentGameIndex);
  // Buttons disabled when there's no ready sibling in that direction —
  // prevents dead clicks during phase-B expansion at the head/tail.
  const hasReadyBefore = sorted.slice(0, Math.max(0, pos)).some((g) => isGameReady(g.index));
  const hasReadyAfter  = sorted.slice(pos + 1).some((g) => isGameReady(g.index));
  const setBtn = (action, disabled) => {
    const b = host.querySelector(`button[data-action="${action}"]`);
    if (b) b.disabled = disabled;
  };
  setBtn('first-game', !hasReadyBefore);
  setBtn('prev-game',  !hasReadyBefore);
  setBtn('next-game',  !hasReadyAfter);
  setBtn('last-game',  !hasReadyAfter);
}

function setupCorpusNav() {
  const host = document.querySelector('.corpus-nav');
  if (!host) return;
  host.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn || btn.disabled) return;
    switch (btn.dataset.action) {
      case 'first-game': jumpGame('first'); break;
      case 'prev-game':  stepGame(-1);      break;
      case 'next-game':  stepGame(+1);      break;
      case 'last-game':  jumpGame('last');  break;
    }
  });
  on('game', refreshCorpusNav);
  refreshCorpusNav();
}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */
function init() {
  setupDropZone();
  setupKeyboard();
  setupTableSorting();
  setupCorpusNav();
  initBoard();
  initHeatmap();
  initChart();

  // Initial UI state
  document.body.className = 'state-landing';

  // Discover bundled corpora from dataset/index.json and render cards.
  // Fire-and-forget — the drop zone works regardless of whether this
  // resolves successfully (e.g. no dataset/, or fetch blocked).
  renderDatasetList().catch((e) => console.warn('dataset list:', e));

  // If hash present, hint to user (already done in setupDropZone).
}

document.addEventListener('DOMContentLoaded', init);
