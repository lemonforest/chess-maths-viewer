/* chess-overlay.js — paints the channel overlay into chessboard.js squares.
 *
 * Approach: instead of layering an SVG on top of the board (which always
 * paints above the floated square cells where the pieces live), tint each
 * square via its own `background-image`. CSS stacks background-image over
 * background-color, so the underlying light/dark checker pattern (set by
 * chessboard.js's CSS classes) shows through the alpha-blended overlay,
 * and the piece <img> (a child of the square) naturally renders on top of
 * its own square's background — no z-index shenanigans needed.
 *
 * Interface:
 *     const ov = attachChessOverlay(hostId);
 *     ov.setOverlay({ bySquare: Float32Array(64), absMax });  // tint
 *     ov.setOverlay(null);                                    // clear
 *     ov.setFlipped(true);                                    // no-op (squares are addressed by name)
 *     ov.destroy();
 */

import { divergingColor } from './spectral.js';

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];

function _squareName(i) {
  return FILES[i & 7] + String((i >> 3) + 1);
}

export function attachChessOverlay(hostId) {
  let lastData = null;
  let painted = false;          // any squares currently tinted?

  function _eachSquare(fn) {
    const host = document.getElementById(hostId);
    if (!host) return false;
    let touched = 0;
    for (let i = 0; i < 64; i++) {
      const el = host.querySelector(`[data-square="${_squareName(i)}"]`);
      if (!el) continue;
      fn(el, i);
      touched++;
    }
    return touched === 64;
  }

  function _setBg(el, value) {
    // viewer.css sets background-color on squares (not the shorthand), so
    // background-image is untouched and inline styles win without !important.
    if (value) el.style.backgroundImage = value;
    else       el.style.removeProperty('background-image');
  }

  function _clear() {
    if (!painted) return;
    _eachSquare((el) => _setBg(el, ''));
    painted = false;
  }

  function _paint(data) {
    const { bySquare, absMax } = data;
    const inv = absMax > 0 ? 1 / absMax : 0;
    const ok = _eachSquare((el, i) => {
      const v = bySquare[i];
      let t = v * inv;
      if (t < -1) t = -1; else if (t > 1) t = 1;
      const alpha = Math.abs(t);
      if (alpha <= 0) {
        _setBg(el, '');
        return;
      }
      const [r, g, b] = divergingColor(t);
      const c = `rgba(${r},${g},${b},${alpha})`;
      // Solid gradient: the simplest way to declare a layered tint via
      // background-image (background-color stays as the checker class).
      _setBg(el, `linear-gradient(${c},${c})`);
    });
    if (!ok) {
      // Squares not mounted yet; retry next frame.
      requestAnimationFrame(() => _paint(data));
      return;
    }
    painted = true;
  }

  function setOverlay(data) {
    lastData = data || null;
    if (!lastData) _clear();
    else           _paint(lastData);
  }

  function setFlipped(_f) {
    // chessboard.js's flip rearranges squares but keeps each cell's
    // data-square attribute. Re-applying the same payload picks up the
    // new layout automatically.
    if (lastData) _paint(lastData);
  }

  function destroy() {
    _clear();
    lastData = null;
  }

  return { setOverlay, setFlipped, destroy };
}
