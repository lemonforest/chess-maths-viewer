/* board.js — game-board host + playback controls.
 *
 * Delegates actual rendering to a driver chosen by the corpus variant:
 *   - "chess"   → chessboard.js (UMD global `Chessboard`), FEN-driven
 *   - "othello" → SVG discs rendered inline by ./othello-board.js
 *
 * Both drivers expose the same tiny interface:
 *
 *     { init(hostId), setPosition(plyData), resize(), flip(), destroy() }
 *
 * `setPosition` receives the ndjson ply record for the current ply (or null
 * to reset to the starting position). The chess driver reads `ply.fen`; the
 * othello driver reads `ply.board` (64-char string) + optional
 * `ply.last_square`. Each driver silently falls back to the starting position
 * if its expected fields are missing, which matters during the brief window
 * between selectGame and ensureGameData resolving.
 */

import { state, on as subscribe, set as setState, getActiveGame } from './app.js';
import { createOthelloDriver } from './othello-board.js';
import { attachChessOverlay } from './chess-overlay.js';
import { getOverlayForPly } from './spectral.js';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const board = {
  driver: null,
  variant: null,        // 'chess' | 'othello' — tracks which driver is active
  hostId: 'board',
  flipped: false,
  autoplayTimer: null,
  speeds: [250, 500, 1000, 2000],
};

export function initBoard(rootIds = {
  board: 'board',
  controls: 'board-controls',
  speed: 'speed-btn',
  play: 'play-btn',
  ply: 'board-ply-readout',
}) {
  board.hostId = rootIds.board;
  // Default to the chess driver; swapped on the first 'game' event if the
  // loaded corpus declares variant === "othello".
  _installDriver('chess');

  // Wire control buttons
  const controlsHost = document.getElementById(rootIds.controls);
  controlsHost.addEventListener('click', (evt) => {
    const btn = evt.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    handleAction(action);
  });

  // Resize: the chess driver needs an explicit resize call; the othello
  // driver scales with its container via SVG viewBox and no-ops here.
  window.addEventListener('resize', () => board.driver && board.driver.resize());

  // Reactive subscriptions
  subscribe('ply', () => {
    syncBoardToPly();
    syncInfoPanel();
    syncReadout();
    syncOverlay();
  });
  subscribe('game', () => {
    _ensureDriverForActiveCorpus();
    stopAutoplay();
    syncBoardToPly();
    syncInfoPanel();
    syncReadout();
    syncOverlay();
  });
  subscribe('heatmapView', syncOverlay);
  subscribe('boardOverlay', () => {
    syncOverlay();
    const btn = document.querySelector('button[data-action="overlay"]');
    if (btn) {
      btn.setAttribute('aria-pressed', state.boardOverlay ? 'true' : 'false');
      btn.classList.toggle('active', state.boardOverlay);
    }
  });
  subscribe('plainBoard', () => {
    const host = document.getElementById(board.hostId);
    if (host) host.classList.toggle('plain-board', state.plainBoard);
    const btn = document.querySelector('button[data-action="plain"]');
    if (btn) {
      btn.setAttribute('aria-pressed', state.plainBoard ? 'true' : 'false');
      btn.classList.toggle('active', state.plainBoard);
    }
  });
  subscribe('autoplay', () => {
    const playBtn = document.getElementById(rootIds.play);
    if (state.autoplay.running) {
      playBtn.textContent = '⏸';
      playBtn.classList.add('active');
    } else {
      playBtn.textContent = '▶';
      playBtn.classList.remove('active');
    }
  });
}

/* ------------------------------------------------------------------ *
 * Driver management
 * ------------------------------------------------------------------ */

function _installDriver(variant) {
  if (board.driver && board.variant === variant) return;
  if (board.driver) {
    try { board.driver.destroy(); } catch (e) { console.warn('driver.destroy:', e); }
    board.driver = null;
  }
  board.variant = variant;
  board.flipped = false;
  board.driver = variant === 'othello' ? _createChessLikeOthello(board.hostId)
                                       : _createChessDriver(board.hostId);
  board.driver.init(board.hostId);
}

function _ensureDriverForActiveCorpus() {
  const variant = (state.corpus && state.corpus.variant) || 'chess';
  _installDriver(variant);
}

function _createChessDriver(hostId) {
  // Thin adapter around chessboard.js so board.js sees the same interface as
  // the othello driver.
  let cb = null;
  let overlay = null;
  return {
    init(id = hostId) {
      cb = window.Chessboard(id, {
        position: STARTING_FEN,
        pieceTheme: window.__inlineChessPieceTheme,
        showNotation: true,
        moveSpeed: 160,
        snapbackSpeed: 0,
        snapSpeed: 0,
        appearSpeed: 100,
      });
      overlay = attachChessOverlay(id);
    },
    setPosition(ply) {
      if (!cb) return;
      const fen = (ply && typeof ply.fen === 'string') ? ply.fen : STARTING_FEN;
      // Animate transitions (same behavior as before).
      cb.position(fen, true);
    },
    resize() { if (cb) cb.resize(); },
    flip()   {
      if (cb) cb.flip();
      if (overlay) overlay.setFlipped(board.flipped);
    },
    setOverlay(data) { if (overlay) overlay.setOverlay(data); },
    destroy() {
      if (overlay) { try { overlay.destroy(); } catch (e) { /* best-effort */ } }
      overlay = null;
      if (cb && typeof cb.destroy === 'function') {
        try { cb.destroy(); } catch (e) { /* chessboard.js destroy is best-effort */ }
      }
      cb = null;
      // chessboard.js leaves the host populated; wipe it so a subsequent
      // driver can start from a clean slate.
      const host = document.getElementById(hostId);
      if (host) host.innerHTML = '';
    },
  };
}

function _createChessLikeOthello(hostId) {
  return createOthelloDriver(hostId);
}

/* ------------------------------------------------------------------ *
 * Playback controls
 * ------------------------------------------------------------------ */

function handleAction(action) {
  const game = getActiveGame();
  if (!game) return;
  const n = game.spectral?.nPlies ?? game.plies?.length ?? 0;
  if (n <= 0) return;
  switch (action) {
    case 'first': setState({ currentPly: 0 }); break;
    case 'prev':  setState({ currentPly: Math.max(0, state.currentPly - 1) }); break;
    case 'next':  setState({ currentPly: Math.min(n - 1, state.currentPly + 1) }); break;
    case 'last':  setState({ currentPly: n - 1 }); break;
    case 'play':  toggleAutoplay(); break;
    case 'speed': cycleSpeed(); break;
    case 'flip':
      board.flipped = !board.flipped;
      if (board.driver) board.driver.flip();
      break;
    case 'overlay': setState({ boardOverlay: !state.boardOverlay }); break;
    case 'plain':   setState({ plainBoard: !state.plainBoard });     break;
  }
}

function toggleAutoplay() {
  if (state.autoplay.running) stopAutoplay();
  else startAutoplay();
}

function startAutoplay() {
  if (board.autoplayTimer) return;
  setState({ autoplay: { ...state.autoplay, running: true } });
  board.autoplayTimer = setInterval(() => {
    const game = getActiveGame();
    if (!game) return;
    const n = game.spectral?.nPlies ?? game.plies?.length ?? 0;
    if (n <= 0) return;
    if (state.currentPly >= n - 1) {
      stopAutoplay();
      return;
    }
    setState({ currentPly: state.currentPly + 1 });
  }, state.autoplay.intervalMs);
}

function stopAutoplay() {
  if (board.autoplayTimer) {
    clearInterval(board.autoplayTimer);
    board.autoplayTimer = null;
  }
  if (state.autoplay.running) {
    setState({ autoplay: { ...state.autoplay, running: false } });
  }
}

function cycleSpeed() {
  const i = board.speeds.indexOf(state.autoplay.intervalMs);
  const next = board.speeds[(i + 1) % board.speeds.length];
  setState({ autoplay: { ...state.autoplay, intervalMs: next } });
  document.getElementById('speed-btn').textContent = next + 'ms';
  if (state.autoplay.running) {
    stopAutoplay();
    startAutoplay();
  }
}

/* ------------------------------------------------------------------ *
 * Sync helpers
 * ------------------------------------------------------------------ */

function syncOverlay() {
  if (!board.driver || typeof board.driver.setOverlay !== 'function') return;
  if (!state.boardOverlay) {
    board.driver.setOverlay(null);
    return;
  }
  const game = getActiveGame();
  // getOverlayForPly returns null for ALL/FIBER views or missing data,
  // which the drivers treat as "hide overlay". The toggle button's pressed
  // state is preserved so returning to a single-channel view re-shows it.
  const data = getOverlayForPly(game, state.currentPly, state.heatmapView);
  board.driver.setOverlay(data);
}

function syncBoardToPly() {
  const game = getActiveGame();
  // Plies may be unparsed briefly between selectGame being invoked and
  // ensureGameData resolving. Reset to the starting position until then
  // rather than dereferencing a null array.
  if (!game || !game.plies) {
    if (board.driver) board.driver.setPosition(null);
    return;
  }
  const ply = clampPly(game, state.currentPly);
  const record = game.plies[ply] || null;
  if (board.driver) board.driver.setPosition(record);
}

function clampPly(game, ply) {
  const n = game.spectral?.nPlies ?? game.plies?.length ?? 1;
  return Math.max(0, Math.min(n - 1, ply));
}

function syncReadout() {
  const game = getActiveGame();
  if (!game) return;
  const n = game.spectral?.nPlies ?? game.plies?.length ?? 0;
  const el = document.getElementById('board-ply-readout');
  if (el) el.textContent = n > 0 ? `ply ${state.currentPly}/${n - 1}` : 'ply —/—';
}

function syncInfoPanel() {
  const game = getActiveGame();
  if (!game) return;
  const m = game.meta;
  const ply = clampPly(game, state.currentPly);
  const p = game.plies ? game.plies[ply] : null;
  setText('info-move',
    p && p.san ? `${moveNumberFor(ply)}${p.san}` : '—');
  setText('info-eval',  p?.eval || '—');
  setText('info-clock', p?.clk  || '—');
  // Manifest already carries eco/opening_name; PGN is no longer eagerly
  // loaded, so game.pgn is null and the PGN regex fallback is skipped.
  setText('info-opening',
    [m.eco, m.opening_name].filter(Boolean).join(' · ') ||
    extractOpeningFromPgn(game.pgn) || '—');
  setText('info-white', `${m.white}${m.white_elo ? ` (${m.white_elo})` : ''}`);
  setText('info-black', `${m.black}${m.black_elo ? ` (${m.black_elo})` : ''}`);
  setText('info-result', m.result || '—');
}

function moveNumberFor(ply) {
  if (ply <= 0) return '';
  const moveNum = Math.ceil(ply / 2);
  const isWhite = ply % 2 === 1;
  return isWhite ? `${moveNum}. ` : `${moveNum}… `;
}

function extractOpeningFromPgn(pgn) {
  if (!pgn) return null;
  const eco = /\[ECO "([^"]+)"\]/.exec(pgn)?.[1];
  const opening = /\[Opening "([^"]+)"\]/.exec(pgn)?.[1];
  return [eco, opening].filter(Boolean).join(' · ');
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

export function refreshBoard() {
  _ensureDriverForActiveCorpus();
  syncBoardToPly();
  syncInfoPanel();
  syncReadout();
  if (board.driver) board.driver.resize();
}
