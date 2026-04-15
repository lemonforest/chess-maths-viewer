/* app.js — application entry point.
 *
 * Owns the single source of truth for runtime state, the pub/sub bus,
 * keyboard shortcuts, URL hash sync, and panel wiring. Imported first
 * by index.html as a module; pulls in the rest of the JS lazily.
 */

import { loadCorpusFromFile, parseGameSpectral, formatBytes } from './loader.js';
import {
  CHANNELS,
  CHANNEL_BY_ID,
  initHeatmap,
  refreshHeatmap,
} from './spectral.js';
import { initChart, refreshChart } from './charts.js';
import { initBoard, refreshBoard } from './board.js';

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
  let changed = new Set();
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
      const n = game.spectral?.nPlies ?? game.plies.length;
      state.currentPly = Math.max(0, Math.min(n - 1, state.currentPly | 0));
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
  };
}

/* ------------------------------------------------------------------ *
 * Loading flow
 * ------------------------------------------------------------------ */
/** Filename of the sample corpus shipped at the repo root. */
const SAMPLE_CORPUS_PATH = './sweep_chain_lichess_drnykterstein_2026-04-14_N10.7z';

/** Fetch the bundled .7z from the repo root and feed it through startLoad. */
async function loadBundledSample() {
  const url = new URL(SAMPLE_CORPUS_PATH, document.baseURI).href;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${SAMPLE_CORPUS_PATH}`);
  const blob = await resp.blob();
  const file = new File([blob], SAMPLE_CORPUS_PATH.split('/').pop(), {
    type: 'application/x-7z-compressed',
    lastModified: Date.now(),
  });
  return startLoad(file);
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

    // If selected game wasn't pre-parsed, parse now
    const g = corpus.games[state.currentGameIndex];
    if (!g.spectral) await parseGameSpectral(corpus, state.currentGameIndex);

    if (hash?.ply != null) state.currentPly = hash.ply;
    else                   state.currentPly = 0;

    // Reveal viewer
    document.body.className = 'state-viewer';

    // Render initial state
    renderCorpusTable();
    renderChainBreadcrumb();
    setCorpusMeta();

    // Notify panels (they were registered for events but we want a kick)
    emit('game');
    emit('heatmapView');
    emit('activeChannels');
    emit('chartScale');
    emit('evalOverlay');
    emit('ply');
    syncHash();
  } catch (err) {
    console.error('corpus load failed:', err);
    const li = document.createElement('li');
    li.className = 'err';
    li.textContent = 'Failed: ' + (err?.message || err);
    log.appendChild(li);
    setTimeout(() => { document.body.className = 'state-landing'; }, 3500);
  }
}

/* ------------------------------------------------------------------ *
 * Corpus table
 * ------------------------------------------------------------------ */
function renderCorpusTable() {
  const tbody = document.querySelector('#game-table tbody');
  tbody.innerHTML = '';
  const games = sortedGames();
  for (const g of games) {
    const tr = document.createElement('tr');
    tr.dataset.index = g.index;
    if (g.index === state.currentGameIndex) tr.classList.add('active');
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
    tr.addEventListener('click', () => selectGame(g.index));
    tbody.appendChild(tr);
  }
  updateSortIndicators();
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

async function selectGame(index) {
  if (index === state.currentGameIndex) return;
  // Lazy parse spectral if needed
  const g = state.corpus.games[index];
  if (!g.spectral) {
    try {
      await parseGameSpectral(state.corpus, index);
    } catch (e) {
      console.error('spectral parse failed:', e);
      return;
    }
  }
  set({ currentGameIndex: index, currentPly: 0 });
  // Update active row highlight
  for (const tr of document.querySelectorAll('#game-table tbody tr')) {
    tr.classList.toggle('active', parseInt(tr.dataset.index, 10) === index);
  }
  renderChainBreadcrumb();
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

  for (let i = 0; i < path.length; i++) {
    if (i > 0) {
      const arrow = document.createElement('span');
      arrow.className = 'arrow';
      arrow.textContent = '→';
      host.appendChild(arrow);
    }
    const node = document.createElement('span');
    node.className = 'node';
    if (activeSet.has(path[i])) node.classList.add('active');
    node.textContent = path[i];
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

  // Reload button
  document.getElementById('reload-btn').addEventListener('click', () => {
    document.body.className = 'state-landing';
  });

  // "Load bundled sample" button — fetches the .7z that ships in the repo
  // root, so visitors can try the viewer without supplying a corpus.
  const sampleBtn = document.getElementById('load-sample-btn');
  if (sampleBtn) {
    sampleBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      sampleBtn.disabled = true;
      try {
        await loadBundledSample();
      } catch (err) {
        sampleBtn.disabled = false;
        alert('Could not load bundled sample: ' + (err?.message || err));
      }
    });
  }

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
    const n = game.spectral?.nPlies ?? game.plies.length;

    switch (e.key) {
      case 'ArrowLeft':
        set({ currentPly: Math.max(0, state.currentPly - 1) });
        e.preventDefault();
        break;
      case 'ArrowRight':
        set({ currentPly: Math.min(n - 1, state.currentPly + 1) });
        e.preventDefault();
        break;
      case 'Home':
        set({ currentPly: 0 });
        e.preventDefault();
        break;
      case 'End':
        set({ currentPly: n - 1 });
        e.preventDefault();
        break;
      case ' ':
        document.querySelector('button[data-action="play"]').click();
        e.preventDefault();
        break;
      case 'Escape':
        if (state.autoplay.running) {
          document.querySelector('button[data-action="play"]').click();
        }
        e.preventDefault();
        break;
    }

    // Game number shortcuts (1–9, 0=10)
    if (/^[0-9]$/.test(e.key)) {
      const wantIdx = e.key === '0' ? 10 : parseInt(e.key, 10);
      const exists  = state.corpus.games[wantIdx];
      if (exists) selectGame(wantIdx);
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
 * Bootstrap
 * ------------------------------------------------------------------ */
function init() {
  setupDropZone();
  setupKeyboard();
  setupTableSorting();
  initBoard();
  initHeatmap();
  initChart();

  // Initial UI state
  document.body.className = 'state-landing';

  // If hash present, hint to user (already done in setupDropZone).
}

document.addEventListener('DOMContentLoaded', init);
