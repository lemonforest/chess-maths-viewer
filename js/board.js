/* board.js — chessboard + playback controls.
 *
 * Uses chessboard.js (UMD global `Chessboard`). The position is driven
 * directly from the ndjson FEN at the current ply, which is authoritative
 * and avoids any move-replay state drift, so chess.js is not required.
 */

import { state, on as subscribe, set as setState, getActiveGame } from './app.js';

const board = {
  cb: null,           // Chessboard.js instance
  hostId: 'board',
  flipped: false,
  autoplayTimer: null,
  speeds: [250, 500, 1000, 2000],
};

const STARTING_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export function initBoard(rootIds = {
  board: 'board',
  controls: 'board-controls',
  speed: 'speed-btn',
  play: 'play-btn',
  ply: 'board-ply-readout',
}) {
  board.hostId = rootIds.board;
  board.cb = window.Chessboard(rootIds.board, {
    position: STARTING_FEN,
    pieceTheme: window.__inlineChessPieceTheme,
    showNotation: true,
    moveSpeed: 160,
    snapbackSpeed: 0,
    snapSpeed: 0,
    appearSpeed: 100,
  });

  // Wire control buttons
  const controlsHost = document.getElementById(rootIds.controls);
  controlsHost.addEventListener('click', (evt) => {
    const btn = evt.target.closest('button[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    handleAction(action);
  });

  // Resize: chessboard.js needs an explicit resize call
  window.addEventListener('resize', () => board.cb.resize());

  // Reactive subscriptions
  subscribe('ply', () => {
    syncBoardToPly();
    syncInfoPanel();
    syncReadout();
  });
  subscribe('game', () => {
    stopAutoplay();
    syncBoardToPly();
    syncInfoPanel();
    syncReadout();
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
    case 'flip':  board.cb.flip(); board.flipped = !board.flipped; break;
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

function syncBoardToPly() {
  const game = getActiveGame();
  // Plies may be unparsed briefly between selectGame being invoked and
  // ensureGameData resolving. Render the starting position until then
  // rather than dereferencing a null array.
  if (!game || !game.plies) {
    if (board.cb) board.cb.position(STARTING_FEN, false);
    return;
  }
  const ply = clampPly(game, state.currentPly);
  const fen = game.plies[ply]?.fen ?? STARTING_FEN;
  board.cb.position(fen, true);
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
  syncBoardToPly();
  syncInfoPanel();
  syncReadout();
  if (board.cb) board.cb.resize();
}
