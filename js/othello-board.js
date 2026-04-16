/* othello-board.js — SVG-based Othello renderer.
 *
 * Mirrors the structure and CSS classes produced by othello/svg.py (which in
 * turn mirrors chess.svg.board): 8×8 alternating-shade squares inside a
 * coordinate gutter, with discs drawn as <circle> elements classed
 * ".disc.black" / ".disc.white".
 *
 * Expected per-ply data shape:
 *   {
 *     board: string,          // 64 chars: 'B', 'W', or '.' (A1=index 0 … H8=63)
 *     last_square?: string,   // optional, e.g. "e6" — highlights drop square
 *     ...                     // any other fields (san/uci/eval/clk) are ignored here
 *   }
 *
 * The renderer is a factory returning a driver with the same shape as the
 * chess driver (init/setPosition/resize/flip/destroy) so board.js can swap
 * between them without the rest of the viewer noticing.
 */

import { divergingColor } from './spectral.js';

const SQUARE_SIZE = 45;
const MARGIN = 20;
const DISC_RADIUS = 20;
const INNER = 8 * SQUARE_SIZE;
const TOTAL = INNER + 2 * MARGIN;

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const STARTING_BOARD = _emptyBoard((s) => {
  if (s === _sq('d', 4) || s === _sq('e', 5)) return 'W';
  if (s === _sq('d', 5) || s === _sq('e', 4)) return 'B';
  return '.';
});

function _sq(fileChar, rank1Based) {
  const f = FILES.indexOf(fileChar);
  const r = rank1Based - 1;
  return (r << 3) | f;
}

function _emptyBoard(fill) {
  const out = new Array(64);
  for (let s = 0; s < 64; s++) out[s] = typeof fill === 'function' ? fill(s) : fill;
  return out.join('');
}

/**
 * Create an Othello board driver bound to a host element by id.
 * The host is wiped and replaced with the board SVG on init().
 */
export function createOthelloDriver(hostId) {
  let host = null;
  let svgEl = null;
  let discsGroup = null;
  let squaresGroup = null;
  let overlayGroup = null;
  let whiteBottom = true;       // orientation: white-at-bottom by default (mirrors chess.svg)
  let currentBoardStr = STARTING_BOARD;
  let currentLastSq = null;     // 0..63 or null
  let currentOverlay = null;    // { bySquare: Float32Array(64), absMax } | null

  function init(rootId = hostId) {
    host = document.getElementById(rootId);
    if (!host) throw new Error(`othello-board: host #${rootId} not found`);
    host.innerHTML = '';
    svgEl = _buildSvg();
    host.appendChild(svgEl);
    _render();
  }

  function setPosition(ply) {
    if (!ply) {
      currentBoardStr = STARTING_BOARD;
      currentLastSq = null;
    } else {
      const bs = typeof ply.board === 'string' && ply.board.length === 64
        ? ply.board
        : STARTING_BOARD;
      currentBoardStr = bs;
      currentLastSq = typeof ply.last_square === 'string'
        ? _parseSquare(ply.last_square)
        : null;
    }
    _render();
  }

  function resize() {
    // SVG scales with the container via viewBox — nothing to do. Kept for
    // driver-interface parity with the chess driver.
  }

  function flip() {
    whiteBottom = !whiteBottom;
    _render();
  }

  function setOverlay(data) {
    currentOverlay = data || null;
    _renderOverlay();
  }

  function destroy() {
    if (host) host.innerHTML = '';
    host = null; svgEl = null; discsGroup = null; squaresGroup = null;
    overlayGroup = null; currentOverlay = null;
  }

  /* ---------------- internals ---------------- */

  function _buildSvg() {
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('xmlns', svgNS);
    svg.setAttribute('viewBox', `0 0 ${TOTAL} ${TOTAL}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.width = '100%';
    svg.style.height = '100%';
    svg.style.display = 'block';

    // Inline style block — same CSS class approach as othello.svg.board().
    const defs = document.createElementNS(svgNS, 'defs');
    const style = document.createElementNS(svgNS, 'style');
    style.textContent = `
      .square.light { fill: #ffce9e; }
      .square.dark  { fill: #d18b47; }
      .square.light.lastmove { fill: #cdd26a; }
      .square.dark.lastmove  { fill: #aaa23b; }
      .coord { fill: #e5e5e5; font-family: sans-serif; font-size: 12px; }
      .disc.black { fill: #111; stroke: #000; stroke-width: 1; }
      .disc.white { fill: #f5f5f5; stroke: #000; stroke-width: 1; }
    `;
    defs.appendChild(style);
    svg.appendChild(defs);

    // Translate into the bordered region so (0,0) is the top-left of A8 when
    // white-at-bottom, matching othello.svg.board().
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('transform', `translate(${MARGIN},${MARGIN})`);
    svg.appendChild(g);

    squaresGroup = document.createElementNS(svgNS, 'g');
    squaresGroup.setAttribute('class', 'squares');
    g.appendChild(squaresGroup);

    const coords = _buildCoordinates(svgNS);
    g.appendChild(coords);

    // Channel overlay (between squares and pieces so discs stay legible)
    overlayGroup = document.createElementNS(svgNS, 'g');
    overlayGroup.setAttribute('class', 'board-overlay');
    overlayGroup.setAttribute('pointer-events', 'none');
    g.appendChild(overlayGroup);

    discsGroup = document.createElementNS(svgNS, 'g');
    discsGroup.setAttribute('class', 'pieces');
    g.appendChild(discsGroup);

    return svg;
  }

  function _buildCoordinates(svgNS) {
    const g = document.createElementNS(svgNS, 'g');
    g.setAttribute('class', 'coordinates');
    // Rebuilt on every orientation flip — easiest to just repopulate.
    g.dataset.built = 'pending';
    return g;
  }

  function _renderCoordinates() {
    // Find the coordinates group (second child of the translated g).
    const coordsGroup = svgEl.querySelector('g > g.coordinates');
    if (!coordsGroup) return;
    coordsGroup.innerHTML = '';
    const svgNS = 'http://www.w3.org/2000/svg';
    const files = whiteBottom ? FILES : FILES.slice().reverse();
    const ranks = whiteBottom ? ['8','7','6','5','4','3','2','1']
                              : ['1','2','3','4','5','6','7','8'];
    for (let i = 0; i < 8; i++) {
      const x = i * SQUARE_SIZE + SQUARE_SIZE / 2;
      // bottom gutter
      const tb = document.createElementNS(svgNS, 'text');
      tb.setAttribute('class', 'coord file');
      tb.setAttribute('x', String(x));
      tb.setAttribute('y', String(8 * SQUARE_SIZE + MARGIN - 6));
      tb.setAttribute('text-anchor', 'middle');
      tb.textContent = files[i];
      coordsGroup.appendChild(tb);
      // top gutter
      const tt = document.createElementNS(svgNS, 'text');
      tt.setAttribute('class', 'coord file');
      tt.setAttribute('x', String(x));
      tt.setAttribute('y', '-6');
      tt.setAttribute('text-anchor', 'middle');
      tt.textContent = files[i];
      coordsGroup.appendChild(tt);

      const y = i * SQUARE_SIZE + SQUARE_SIZE / 2 + 4;
      const lr = document.createElementNS(svgNS, 'text');
      lr.setAttribute('class', 'coord rank');
      lr.setAttribute('x', String(-MARGIN + 6));
      lr.setAttribute('y', String(y));
      lr.textContent = ranks[i];
      coordsGroup.appendChild(lr);
      const rr = document.createElementNS(svgNS, 'text');
      rr.setAttribute('class', 'coord rank');
      rr.setAttribute('x', String(8 * SQUARE_SIZE + 4));
      rr.setAttribute('y', String(y));
      rr.textContent = ranks[i];
      coordsGroup.appendChild(rr);
    }
  }

  function _squareXY(sq) {
    const f = sq & 7;
    const r = sq >> 3;
    const col = whiteBottom ? f : 7 - f;
    const row = whiteBottom ? 7 - r : r;
    return { x: col * SQUARE_SIZE, y: row * SQUARE_SIZE };
  }

  function _render() {
    _renderCoordinates();
    _renderSquares();
    _renderOverlay();
    _renderDiscs();
  }

  function _renderOverlay() {
    if (!overlayGroup) return;
    overlayGroup.innerHTML = '';
    if (!currentOverlay) return;
    const { bySquare, absMax } = currentOverlay;
    const inv = absMax > 0 ? 1 / absMax : 0;
    const svgNS = 'http://www.w3.org/2000/svg';
    for (let sq = 0; sq < 64; sq++) {
      const v = bySquare[sq];
      let t = v * inv;
      if (t < -1) t = -1; else if (t > 1) t = 1;
      const alpha = Math.abs(t);
      if (alpha <= 0) continue;
      const [r, g, b] = divergingColor(t);
      const { x, y } = _squareXY(sq);
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', String(SQUARE_SIZE));
      rect.setAttribute('height', String(SQUARE_SIZE));
      rect.setAttribute('fill', `rgb(${r},${g},${b})`);
      rect.setAttribute('fill-opacity', String(alpha));
      overlayGroup.appendChild(rect);
    }
  }

  function _renderSquares() {
    const svgNS = 'http://www.w3.org/2000/svg';
    squaresGroup.innerHTML = '';
    for (let sq = 0; sq < 64; sq++) {
      const { x, y } = _squareXY(sq);
      const f = sq & 7, r = sq >> 3;
      const shade = (f + r) % 2 ? 'light' : 'dark';
      const classes = ['square', shade, _squareName(sq)];
      if (currentLastSq === sq) classes.push('lastmove');
      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttribute('class', classes.join(' '));
      rect.setAttribute('x', String(x));
      rect.setAttribute('y', String(y));
      rect.setAttribute('width', String(SQUARE_SIZE));
      rect.setAttribute('height', String(SQUARE_SIZE));
      squaresGroup.appendChild(rect);
    }
  }

  function _renderDiscs() {
    const svgNS = 'http://www.w3.org/2000/svg';
    discsGroup.innerHTML = '';
    for (let sq = 0; sq < 64; sq++) {
      const ch = currentBoardStr[sq];
      if (ch !== 'B' && ch !== 'W') continue;
      const { x, y } = _squareXY(sq);
      const circle = document.createElementNS(svgNS, 'circle');
      circle.setAttribute('class', ch === 'B' ? 'disc black' : 'disc white');
      circle.setAttribute('cx', String(x + SQUARE_SIZE / 2));
      circle.setAttribute('cy', String(y + SQUARE_SIZE / 2));
      circle.setAttribute('r', String(DISC_RADIUS));
      discsGroup.appendChild(circle);
    }
  }

  function _squareName(sq) {
    return FILES[sq & 7] + String((sq >> 3) + 1);
  }

  function _parseSquare(name) {
    if (typeof name !== 'string' || name.length !== 2) return null;
    const f = FILES.indexOf(name[0].toLowerCase());
    const r = parseInt(name[1], 10) - 1;
    if (f < 0 || r < 0 || r > 7) return null;
    return (r << 3) | f;
  }

  return { init, setPosition, resize, flip, setOverlay, destroy };
}
