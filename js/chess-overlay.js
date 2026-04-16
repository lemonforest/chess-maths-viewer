/* chess-overlay.js — absolutely-positioned SVG layer over chessboard.js.
 *
 * Paints 64 colored rects (one per square) using the diverging palette from
 * js/spectral.js, so any cell of the 1-D heatmap and its corresponding 8×8
 * square show byte-identical RGB. Used by the board driver in js/board.js
 * when the user toggles the ⊞ overlay button.
 *
 * Interface:
 *     const ov = attachChessOverlay(hostId);
 *     ov.setOverlay({ bySquare: Float32Array(64), absMax });  // show
 *     ov.setOverlay(null);                                    // hide
 *     ov.setFlipped(true);                                    // on board flip
 *     ov.destroy();
 *
 * Notes:
 * - The overlay mounts to chessboard.js's inner board container (located
 *   via a square's data-square attribute → parentNode.parentNode) so 1 SVG
 *   user-space unit = 1 square after a viewBox of "0 0 8 8".
 * - pointer-events: none keeps hover/click on chessboard.js itself.
 * - If the inner container isn't mounted yet (e.g. driver.setOverlay called
 *   before the first position), we retry once via requestAnimationFrame.
 */

import { divergingColor } from './spectral.js';

const SVG_NS = 'http://www.w3.org/2000/svg';

export function attachChessOverlay(hostId) {
  let svg = null;
  let rects = null;               // Array(64) of <rect> references
  let mountedOn = null;           // the element the svg is a child of
  let flipped = false;
  let lastData = null;            // replay after re-mount / flip

  function _findBoardContainer() {
    const host = document.getElementById(hostId);
    if (!host) return null;
    // chessboard.js tags every square cell with data-square="a1" etc.
    // Parent is the row; grandparent is the board container (.board-b72b1
    // in v1.0.0). This traversal is resilient to class-suffix changes.
    const anySquare = host.querySelector('[data-square]');
    if (anySquare && anySquare.parentNode && anySquare.parentNode.parentNode) {
      return anySquare.parentNode.parentNode;
    }
    // Fallback: a class-based match against the board container.
    const byClass = host.querySelector('[class*="board-b"]');
    return byClass || host;
  }

  function _buildSvg() {
    const s = document.createElementNS(SVG_NS, 'svg');
    s.setAttribute('class', 'board-overlay');
    s.setAttribute('viewBox', '0 0 8 8');
    s.setAttribute('preserveAspectRatio', 'none');
    s.setAttribute('aria-hidden', 'true');
    s.style.position = 'absolute';
    s.style.inset = '0';
    s.style.width = '100%';
    s.style.height = '100%';
    s.style.pointerEvents = 'none';
    rects = new Array(64);
    for (let i = 0; i < 64; i++) {
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('width', '1');
      r.setAttribute('height', '1');
      r.setAttribute('fill-opacity', '0');
      s.appendChild(r);
      rects[i] = r;
    }
    return s;
  }

  function _ensureMounted() {
    const container = _findBoardContainer();
    if (!container) return false;
    // chessboard.js sets position: relative on the board container, which
    // we need for `inset: 0` to resolve. Set it defensively if missing.
    const cs = getComputedStyle(container);
    if (cs.position === 'static') container.style.position = 'relative';

    if (!svg) svg = _buildSvg();
    if (svg.parentNode !== container) {
      container.appendChild(svg);
      mountedOn = container;
    }
    return true;
  }

  function _render() {
    if (!lastData) {
      if (svg) svg.style.display = 'none';
      return;
    }
    if (!_ensureMounted()) {
      // Board container not built yet — retry next frame.
      requestAnimationFrame(_render);
      return;
    }
    svg.style.display = '';

    const { bySquare, absMax } = lastData;
    const inv = absMax > 0 ? 1 / absMax : 0;
    for (let i = 0; i < 64; i++) {
      const v = bySquare[i];
      let t = v * inv;
      if (t < -1) t = -1; else if (t > 1) t = 1;
      const [r, g, b] = divergingColor(t);
      const file = flipped ? 7 - (i & 7) : (i & 7);
      const row  = flipped ? (i >> 3)    : 7 - (i >> 3);
      const rect = rects[i];
      rect.setAttribute('x', String(file));
      rect.setAttribute('y', String(row));
      rect.setAttribute('fill', `rgb(${r},${g},${b})`);
      rect.setAttribute('fill-opacity', String(Math.abs(t)));
    }
  }

  function setOverlay(data) {
    lastData = data || null;
    _render();
  }

  function setFlipped(f) {
    flipped = !!f;
    _render();
  }

  function destroy() {
    if (svg && svg.parentNode) svg.parentNode.removeChild(svg);
    svg = null;
    rects = null;
    mountedOn = null;
    lastData = null;
  }

  return { setOverlay, setFlipped, destroy };
}
