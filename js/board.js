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
import { attachFiberOverlay, loadFiberNorms } from './fiber-overlay.js';
import { getOverlayForPly, OVERLAY_TRANSFORM_IDS } from './spectral.js';

const FIBER_PIECE_IDS = ['N', 'B', 'R', 'Q', 'K'];
const FIBER_MODE_IDS  = ['gradient', 'discrete'];
const FIBER_CMAP_IDS  = ['viridis', 'diverging', 'mono'];
const ROOK_HELPER = 'Rook fiber is identically zero — its rule content ' +
                    'lives in the diagonal channel, not the off-diagonal ' +
                    'fiber. See notebook §7b.';

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const board = {
  driver: null,
  variant: null,        // 'chess' | 'othello' — tracks which driver is active
  hostId: 'board',
  flipped: false,
  autoplayTimer: null,
  speeds: [250, 500, 1000, 2000],
};

// Static rank-3 fiber-norm data, lazily loaded on initBoard. Lives at
// module scope so driver re-installs (e.g. variant swap) can re-hand
// the data to the freshly-attached fiber-overlay instance without
// repeating the fetch.
let fiberData = null;

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

  // Wire control buttons (playback row below the board)
  const controlsHost = document.getElementById(rootIds.controls);
  controlsHost.addEventListener('click', (evt) => {
    const btn = evt.target.closest('button[data-action]');
    if (!btn) return;
    handleAction(btn.dataset.action);
  });

  // Wire overlay controls hoisted into the panel-header: the ⊞ / ◻ toggles
  // (handled the same way as playback) and the transform seg-control.
  const headerHost = document.querySelector('#board-panel .panel-header');
  if (headerHost) {
    headerHost.addEventListener('click', (evt) => {
      const actionBtn = evt.target.closest('button[data-action]');
      if (actionBtn) {
        handleAction(actionBtn.dataset.action);
        return;
      }
      const txBtn = evt.target.closest('button[data-tx]');
      if (txBtn && OVERLAY_TRANSFORM_IDS.includes(txBtn.dataset.tx)) {
        setState({ overlayTransform: txBtn.dataset.tx });
      }
    });
  }

  // Fiber-overlay controls live in a second row below the panel header;
  // they delegate to app state so the URL hash / restore path stays
  // consistent with the other toggles.
  const fiberHost = document.getElementById('fiber-controls');
  if (fiberHost) {
    fiberHost.addEventListener('click', (evt) => {
      const pBtn = evt.target.closest('button[data-fiber-piece]');
      if (pBtn && FIBER_PIECE_IDS.includes(pBtn.dataset.fiberPiece)) {
        setState({ fiberPiece: pBtn.dataset.fiberPiece });
        return;
      }
      const mBtn = evt.target.closest('button[data-fiber-mode]');
      if (mBtn && FIBER_MODE_IDS.includes(mBtn.dataset.fiberMode)) {
        const next = mBtn.dataset.fiberMode;
        const patch = { fiberMode: next };
        // Discrete fiber + channel overlay fight for the same
        // background-image property. Switching INTO discrete while
        // channel is on → turn channel off so each overlay has a
        // well-defined layer. (The symmetric "channel turning on while
        // fiber is discrete" case is handled in handleAction.)
        if (next === 'discrete' && state.boardOverlay) {
          patch.boardOverlay = false;
        }
        setState(patch);
        return;
      }
      const cBtn = evt.target.closest('button[data-fiber-cmap]');
      if (cBtn && FIBER_CMAP_IDS.includes(cBtn.dataset.fiberCmap)) {
        setState({ fiberCmap: cBtn.dataset.fiberCmap });
      }
    });
  }

  // Fetch the static fiber-norms data once. Small enough (~5 KB) that a
  // plain fetch-on-init suffices; the viewer works without it (the
  // fiber button becomes a no-op with a console warning).
  loadFiberNorms().then((data) => {
    fiberData = data;
    if (board.driver && typeof board.driver.fiber === 'function') {
      const f = board.driver.fiber();
      if (f) f.setData(data);
    }
    // If the user already toggled fiber on before the fetch resolved,
    // re-sync so the overlay actually renders.
    syncFiberOverlay();
  }).catch((e) => console.warn('fiber overlay: data load failed', e));

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
    // Re-sync the fiber overlay too — its gradient alpha depends on
    // whether the channel overlay is also active (companion dim).
    syncFiberOverlay();
    const btn = document.querySelector('button[data-action="overlay"]');
    if (btn) {
      btn.setAttribute('aria-pressed', state.boardOverlay ? 'true' : 'false');
      btn.classList.toggle('active', state.boardOverlay);
    }
  });
  subscribe('overlayTransform', () => {
    syncOverlay();
    // Seg-control: mark the active transform, matching the chart panel's
    // z-score/log/linear pattern (see charts.js).
    document.querySelectorAll('#board-panel .seg-control [data-tx]').forEach((btn) => {
      const active = btn.dataset.tx === state.overlayTransform;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  });
  subscribe('fiberOverlay', () => {
    syncFiberOverlay();
    const btn = document.querySelector('button[data-action="fiber"]');
    if (btn) {
      btn.setAttribute('aria-pressed', state.fiberOverlay ? 'true' : 'false');
      btn.classList.toggle('active', state.fiberOverlay);
    }
    const panel = document.getElementById('fiber-controls');
    if (panel) panel.hidden = !state.fiberOverlay;
  });
  subscribe('fiberPiece', () => { syncFiberOverlay(); syncFiberControlHighlights(); });
  subscribe('fiberMode',  () => { syncFiberOverlay(); syncFiberControlHighlights(); });
  subscribe('fiberCmap',  () => { syncFiberOverlay(); syncFiberControlHighlights(); });
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
  let fiber = null;
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
      fiber = attachFiberOverlay(id);
    },
    setPosition(ply) {
      if (!cb) return;
      const fen = (ply && typeof ply.fen === 'string') ? ply.fen : STARTING_FEN;
      // Animate transitions (same behavior as before).
      cb.position(fen, true);
      // The fiber gradient canvas is anchored by a1/h8 bounding rects —
      // reposition after the piece DOM settles on each ply, since
      // chessboard.js rebuilds the square cells on position changes
      // larger than the simple animation path.
      if (fiber) requestAnimationFrame(() => fiber.relayout());
    },
    resize() {
      if (cb) cb.resize();
      if (fiber) fiber.relayout();
    },
    flip()   {
      if (cb) cb.flip();
      if (overlay) overlay.setFlipped(board.flipped);
      if (fiber)   fiber.setFlipped(board.flipped);
    },
    setOverlay(data) { if (overlay) overlay.setOverlay(data); },
    fiber() { return fiber; },
    destroy() {
      if (overlay) { try { overlay.destroy(); } catch (e) { /* best-effort */ } }
      overlay = null;
      if (fiber)   { try { fiber.destroy();   } catch (e) { /* best-effort */ } }
      fiber = null;
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
  // Non-game-dependent actions run first so the overlay / fiber / plain
  // toggles work even before a corpus is loaded (and during the brief
  // window while the first game's NDJSON + spectralz are being parsed).
  // The fiber overlay in particular is *static* — it doesn't need any
  // ply data — so gating it on game presence was silently swallowing
  // every click until a game finished loading.
  switch (action) {
    case 'overlay': {
      // Channel overlay and fiber overlay CAN coexist as long as the
      // fiber is in 'gradient' mode — fiber uses a separate canvas
      // layer, channel paints per-square background-image, they don't
      // fight at the DOM level. The only genuine conflict is fiber's
      // 'discrete' mode, which paints the same background-image
      // property as channel; if the user flips channel on while fiber
      // is discrete, auto-switch fiber to gradient so both survive.
      const turningOn = !state.boardOverlay;
      const patch = { boardOverlay: turningOn };
      if (turningOn && state.fiberOverlay && state.fiberMode === 'discrete') {
        patch.fiberMode = 'gradient';
      }
      setState(patch);
      return;
    }
    case 'fiber': {
      // Symmetric rule: if the user is turning fiber on and channel is
      // already on, keep channel and force gradient mode so they
      // compose cleanly.
      const turningOn = !state.fiberOverlay;
      const patch = { fiberOverlay: turningOn };
      if (turningOn && state.boardOverlay && state.fiberMode === 'discrete') {
        patch.fiberMode = 'gradient';
      }
      setState(patch);
      return;
    }
    case 'plain':
      setState({ plainBoard: !state.plainBoard });
      return;
    case 'flip':
      board.flipped = !board.flipped;
      if (board.driver) board.driver.flip();
      return;
  }

  // Game-dependent actions — need a loaded game with at least one ply.
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

// Exposed so app.js can stop the timer synchronously when switching games
// via hotkey, without relying on the implicit ordering of the board panel's
// 'game' subscriber.
export { stopAutoplay };

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
  const data = getOverlayForPly(game, state.currentPly, state.heatmapView, state.overlayTransform);
  board.driver.setOverlay(data);
}

function syncFiberOverlay() {
  if (!board.driver || typeof board.driver.fiber !== 'function') return;
  const f = board.driver.fiber();
  if (!f) return;
  // Hand the cached data over whenever the fetch eventually resolves;
  // the overlay no-ops internally if setData hasn't been called yet.
  if (fiberData) f.setData(fiberData);
  f.setPiece(state.fiberPiece);
  f.setMode(state.fiberMode);
  f.setColormap(state.fiberCmap);
  f.setFlipped(board.flipped);
  // Companion flag: only meaningful while the fiber overlay is
  // actually in gradient mode (discrete is mutex with channel).
  f.setCompanionChannelActive(state.boardOverlay && state.fiberMode === 'gradient');
  f.setEnabled(state.fiberOverlay && !!fiberData);

  // Helper text: tell the user *why* the rook is flat rather than
  // letting them wonder if it's broken. Rendered as an absolutely-
  // positioned floating note (see .fiber-helper in viewer.css) so it
  // can't push the board down when rook is selected. We also mirror
  // the text into the R button's `title` for a native browser
  // tooltip on hover — redundant but nice for discoverability.
  const helper = document.getElementById('fiber-helper');
  const rBtn = document.querySelector('[data-fiber-piece="R"]');
  const rookActive = state.fiberOverlay && state.fiberPiece === 'R';
  if (helper) {
    if (rookActive) {
      helper.textContent = ROOK_HELPER;
      helper.hidden = false;
    } else {
      helper.hidden = true;
      helper.textContent = '';
    }
  }
  if (rBtn) {
    rBtn.title = rookActive ? `Rook — ${ROOK_HELPER}` : 'Rook';
  }
}

function syncFiberControlHighlights() {
  const panel = document.getElementById('fiber-controls');
  if (!panel) return;
  const mark = (attr, current) => {
    panel.querySelectorAll(`[${attr}]`).forEach((btn) => {
      const active = btn.getAttribute(attr) === current;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  };
  mark('data-fiber-piece', state.fiberPiece);
  mark('data-fiber-mode',  state.fiberMode);
  mark('data-fiber-cmap',  state.fiberCmap);
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
