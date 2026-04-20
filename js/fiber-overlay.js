/* fiber-overlay.js — static rank-3 fiber-norm overlay.
 *
 * Paints the per-square fiber-norm scalar field for a chosen piece type
 * onto the chessboard surface. The field is a static property of the
 * chess rules (no ply dependence); see data/fiber_norms.json (generated
 * by scripts/generate_fiber_norms.py).
 *
 * Two render modes:
 *
 *   'discrete' — per-square background-image tints, same mechanism as
 *                js/chess-overlay.js. Honest "value at each square".
 *   'gradient' — absolutely-positioned <canvas> layered on top of the
 *                board with CSS-scaled bilinear upsampling, plus the
 *                piece sprites raised above via z-index. Smooth.
 *
 * The board-orientation flip is handled by reading chessboard.js's
 * `data-square` attributes (discrete) and by querying the actual
 * rank-1/rank-8 square bounding rects (gradient) — both transparent to
 * the caller.
 *
 * Interface:
 *
 *   const f = attachFiberOverlay(hostId);
 *   f.setData(fiberNormsJson);          // once, after fetch
 *   f.setPiece('N'); f.setMode('gradient'); f.setColormap('viridis');
 *   f.setEnabled(true);
 *   f.setFlipped(true);                 // called from the board driver
 *   f.relayout();                       // on window resize
 *   f.destroy();
 */

const FILES = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
const PIECE_TO_KEY = { N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };

const VIRIDIS = [
  [ 68,   1,  84],
  [ 59,  82, 139],
  [ 33, 145, 140],
  [ 94, 201,  97],
  [253, 231,  37],
];
// Cool→neutral→warm divergent map, centered on the field's mean.
const DIVERGENT = [
  [  6,  82, 121],  // deep blue
  [ 90, 174, 205],
  [241, 241, 241],  // near-white center
  [220, 120,  80],
  [158,  36,  36],  // deep red
];
// Monochrome "elevation" ramp — dark-to-light greyscale. Designed to
// stay out of the channel overlay's cyan/amber hue zone so fiber can
// read as a brightness field while channel signals punch through as
// coloured per-square spikes. Slight blue bias in the highlights so
// the ramp doesn't drift towards the amber end of channel's palette.
const MONO = [
  [ 20,  20,  24],
  [ 78,  78,  86],
  [138, 138, 146],
  [196, 196, 206],
  [244, 246, 252],
];

function _cmap(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const s = t * (stops.length - 1);
  const i = Math.floor(s);
  const f = s - i;
  const a = stops[i];
  const b = stops[Math.min(stops.length - 1, i + 1)];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

function _squareName(i) {
  return FILES[i & 7] + String((i >> 3) + 1);
}

export function attachFiberOverlay(hostId) {
  const state = {
    data: null,        // parsed fiber_norms.json
    piece: 'N',        // 'N'|'B'|'R'|'Q'|'K'
    mode: 'gradient',  // 'discrete' | 'gradient'
    cmap: 'viridis',   // 'viridis' | 'diverging' | 'mono'
    enabled: false,
    flipped: false,
    // When the channel overlay is also active, we dim the gradient
    // canvas so the per-square channel tints stay readable through
    // it — fiber turns into "ambient elevation" and channel keeps its
    // localised-spike reading.
    companionChannelActive: false,
  };

  let canvas = null;      // <canvas> used by 'gradient' mode
  let painted = false;    // any discrete square currently tinted?

  function _getHost() {
    return document.getElementById(hostId);
  }

  function _ensureCanvas() {
    const host = _getHost();
    if (!host) return null;
    if (canvas && canvas.parentElement === host) return canvas;
    canvas = document.createElement('canvas');
    canvas.className = 'fiber-gradient-canvas';
    canvas.style.position = 'absolute';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '3';
    // Host's position is static by default; the .board-host CSS sets
    // display: grid + place-items: center, so the canvas has to be
    // positioned relative to the inner #board. Insert as a sibling of
    // chessboard.js's table element.
    host.style.position = 'relative';
    host.appendChild(canvas);
    return canvas;
  }

  function _removeCanvas() {
    if (canvas && canvas.parentElement) {
      canvas.parentElement.removeChild(canvas);
    }
    canvas = null;
  }

  function _eachSquare(fn) {
    const host = _getHost();
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

  function _clearDiscrete() {
    if (!painted) return;
    _eachSquare((el) => el.style.removeProperty('background-image'));
    painted = false;
  }

  function _currentField() {
    if (!state.data) return null;
    const key = PIECE_TO_KEY[state.piece];
    const vals = state.data.values?.[key];
    if (!vals || vals.length !== 64) return null;
    // Float32Array for cheaper array math downstream.
    const f = new Float32Array(64);
    for (let i = 0; i < 64; i++) f[i] = vals[i];
    return f;
  }

  function _tForCmap(v, vMin, vMax, mean) {
    if (state.cmap === 'diverging') {
      // Map so the field's mean lands at 0.5; clip at the max deviation
      // on either side.
      const span = Math.max(Math.abs(vMax - mean), Math.abs(vMin - mean), 1e-12);
      return 0.5 + (v - mean) / (2 * span);
    }
    // Perceptual monotonic: [min, max] → [0, 1].
    const span = vMax - vMin;
    return span > 1e-12 ? (v - vMin) / span : 0.5;
  }

  function _colorFor(v, vMin, vMax, mean) {
    const t = _tForCmap(v, vMin, vMax, mean);
    let stops;
    if (state.cmap === 'diverging')   stops = DIVERGENT;
    else if (state.cmap === 'mono')   stops = MONO;
    else                              stops = VIRIDIS;
    return _cmap(stops, t);
  }

  function _gradientAlpha(isFlat) {
    if (isFlat) return 0.35;
    // Dim when channel overlay is also active so its per-square tints
    // stay readable through the fiber canvas. Mono gets a slightly
    // higher companion alpha since its achromatic shading competes
    // less with the channel's cyan/amber hues.
    if (state.companionChannelActive) {
      return state.cmap === 'mono' ? 0.5 : 0.42;
    }
    return 0.72;
  }

  function _paintDiscrete() {
    const field = _currentField();
    if (!field) return;
    const vMin = Math.min.apply(null, field);
    const vMax = Math.max.apply(null, field);
    const mean = field.reduce((a, b) => a + b, 0) / field.length;
    // Rook: vMax == vMin == 0 → all zero, so paint a single faint tint
    // so the user sees *something* rather than an empty board.
    const isFlat = vMax - vMin < 1e-9;

    const ok = _eachSquare((el, i) => {
      const [r, g, b] = isFlat
        ? [80, 80, 100]   // uniform neutral for the zero rook field
        : _colorFor(field[i], vMin, vMax, mean);
      // Discrete mode is mutex with channel in board.js, so the
      // companion dim doesn't apply here — always use the full
      // single-overlay alpha.
      const alpha = isFlat ? 0.35 : 0.7;
      el.style.backgroundImage =
        `linear-gradient(rgba(${r},${g},${b},${alpha}),rgba(${r},${g},${b},${alpha}))`;
    });
    if (!ok) {
      requestAnimationFrame(_paintDiscrete);
      return;
    }
    painted = true;
  }

  function _paintGradient() {
    const host = _getHost();
    const cv = _ensureCanvas();
    if (!host || !cv) return;

    const anyA1 = host.querySelector('[data-square="a1"]');
    const anyH8 = host.querySelector('[data-square="h8"]');
    if (!anyA1 || !anyH8) { requestAnimationFrame(_paintGradient); return; }

    // Align the canvas with the 8×8 square region (excluding chessboard.js's
    // rank/file label band). Uses host-rect as the coordinate origin.
    const pr = host.getBoundingClientRect();
    const a1 = anyA1.getBoundingClientRect();
    const h8 = anyH8.getBoundingClientRect();
    const left   = Math.min(a1.left,  h8.left);
    const top    = Math.min(a1.top,   h8.top);
    const right  = Math.max(a1.right, h8.right);
    const bottom = Math.max(a1.bottom, h8.bottom);
    const w = right - left;
    const h = bottom - top;
    if (w <= 0 || h <= 0) { requestAnimationFrame(_paintGradient); return; }

    cv.style.left   = (left - pr.left) + 'px';
    cv.style.top    = (top - pr.top)   + 'px';
    cv.style.width  = w + 'px';
    cv.style.height = h + 'px';
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const px = Math.max(64, Math.round(w * dpr));
    cv.width = px; cv.height = px;

    const field = _currentField();
    if (!field) return;
    const vMin = Math.min.apply(null, field);
    const vMax = Math.max.apply(null, field);
    const mean = field.reduce((a, b) => a + b, 0) / field.length;
    const isFlat = vMax - vMin < 1e-9;

    // Build a tiny 8×8 source image, let the main canvas's scaler
    // bilinearly upsample it. Flip vertically so rank 1 is at the
    // bottom (matches chessboard.js's rendering with white on bottom;
    // if state.flipped, we swap vertical+horizontal to keep alignment).
    const src = document.createElement('canvas');
    src.width = 8; src.height = 8;
    const sctx = src.getContext('2d');
    const img = sctx.createImageData(8, 8);
    for (let i = 0; i < 64; i++) {
      const r = i >> 3, c = i & 7;
      const [R, G, B] = isFlat
        ? [80, 80, 100]
        : _colorFor(field[i], vMin, vMax, mean);
      // Destination (row, col) in the source image:
      //   normal:   rank 1 at bottom → row 0 goes to y = 7
      //   flipped:  rank 1 at top    → row 0 goes to y = 0, cols reversed
      const y = state.flipped ? r : (7 - r);
      const x = state.flipped ? (7 - c) : c;
      const o = (y * 8 + x) * 4;
      img.data[o]     = R;
      img.data[o + 1] = G;
      img.data[o + 2] = B;
      img.data[o + 3] = Math.round(255 * _gradientAlpha(isFlat));
    }
    sctx.putImageData(img, 0, 0);

    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, px, px);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, px, px);

    // Raise the chessboard.js piece sprites above the canvas. Keeping
    // this in JS (rather than CSS) scopes it to this host so the bare
    // chessboard without an overlay isn't affected.
    host.classList.add('fiber-gradient-on');
  }

  function _render() {
    // Always start by clearing whichever mode is NOT active.
    if (!state.enabled || !state.data) {
      _clearDiscrete();
      _removeCanvas();
      const host = _getHost();
      if (host) host.classList.remove('fiber-gradient-on');
      return;
    }
    if (state.mode === 'discrete') {
      _removeCanvas();
      const host = _getHost();
      if (host) host.classList.remove('fiber-gradient-on');
      _paintDiscrete();
    } else {
      _clearDiscrete();
      _paintGradient();
    }
  }

  return {
    setData(data) { state.data = data; _render(); },
    setPiece(p) {
      if (!PIECE_TO_KEY[p]) return;
      state.piece = p;
      _render();
    },
    setMode(m) {
      if (m !== 'discrete' && m !== 'gradient') return;
      state.mode = m;
      _render();
    },
    setColormap(c) {
      if (c !== 'viridis' && c !== 'diverging' && c !== 'mono') return;
      state.cmap = c;
      _render();
    },
    setEnabled(on) { state.enabled = !!on; _render(); },
    setFlipped(f) { state.flipped = !!f; if (state.enabled) _render(); },
    /** Lets board.js tell us when the channel overlay is ALSO active,
     *  so the gradient canvas can dim itself to let the per-square
     *  channel tints show through. No-op in discrete mode (mutex
     *  enforced at the handleAction layer in board.js). */
    setCompanionChannelActive(on) {
      state.companionChannelActive = !!on;
      if (state.enabled && state.mode === 'gradient') _render();
    },
    relayout() { if (state.enabled && state.mode === 'gradient') _paintGradient(); },
    getState() { return { ...state }; },
    destroy() {
      _clearDiscrete();
      _removeCanvas();
      const host = _getHost();
      if (host) host.classList.remove('fiber-gradient-on');
      state.enabled = false;
    },
  };
}

/** Fetch data/fiber_norms.json relative to this module. Returns the
 *  parsed JSON on success, null on any failure (viewer falls back to
 *  hiding the fiber UI — see js/board.js). */
export async function loadFiberNorms() {
  const url = new URL('../data/fiber_norms.json', import.meta.url).href;
  try {
    const resp = await fetch(url, { cache: 'force-cache' });
    if (!resp.ok) return null;
    return await resp.json();
  } catch (e) {
    console.warn('fiber-overlay: could not load fiber_norms.json:', e);
    return null;
  }
}
