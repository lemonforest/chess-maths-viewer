/* spectral.js — channel definitions, color palette, and the canvas heatmap.
 *
 * Channel layout matches the spec exactly:
 *   index 0..9 → A1, A2, B1, B2, E, F1, F2, F3, FA, FD
 *   each channel = 64 contiguous Float32 eigenmode values
 *
 * The heatmap is a Canvas2D image built off-screen at native cell
 * resolution (one canvas pixel per (ply, mode) cell) and stretched into
 * the panel via drawImage with image-rendering: pixelated. This avoids
 * the 80k+ rect cost of an SVG implementation.
 */

import { state, on as subscribe, set as setState, getActiveGame } from './app.js';

/* ------------------------------------------------------------------ *
 * Channel registry
 * ------------------------------------------------------------------ */
export const CHANNELS = [
  { id: 'A1', index: 0, label: 'A₁', desc: 'D₄ singlet — rotational complexity',  color: '#e6194b' },
  { id: 'A2', index: 1, label: 'A₂', desc: 'D₄ antisymmetric singlet',            color: '#f032e6' },
  { id: 'B1', index: 2, label: 'B₁', desc: 'diagonal-reflection symmetry',        color: '#42d4f4' },
  { id: 'B2', index: 3, label: 'B₂', desc: 'anti-diagonal reflection',            color: '#469990' },
  { id: 'E',  index: 4, label: 'E',  desc: '2-D irrep — total board energy',      color: '#ffffff' },
  { id: 'F1', index: 5, label: 'F₁', desc: 'fiber 1 — cross-piece interaction',   color: '#3cb44b' },
  { id: 'F2', index: 6, label: 'F₂', desc: 'fiber 2',                              color: '#bfef45' },
  { id: 'F3', index: 7, label: 'F₃', desc: 'fiber 3',                              color: '#4363d8' },
  { id: 'FA', index: 8, label: 'F_A', desc: 'pawn antisymmetric (Z₂ break)',      color: '#911eb4' },
  { id: 'FD', index: 9, label: 'F_D', desc: 'fiber determinant — topology',       color: '#f58231' },
];
export const CHANNEL_BY_ID = Object.fromEntries(CHANNELS.map((c) => [c.id, c]));

// Derived channel: total fiber energy = F1+F2+F3 (only meaningful in line chart)
export const DERIVED_CHANNELS = [
  { id: 'FT', label: 'F_total', desc: 'Σ(F₁,F₂,F₃) — total fiber energy', color: '#ff8c42' },
];

export const HEATMAP_VIEWS = [
  { id: 'A1', label: 'A₁' },
  { id: 'A2', label: 'A₂' },
  { id: 'B1', label: 'B₁' },
  { id: 'B2', label: 'B₂' },
  { id: 'E',  label: 'E'  },
  { id: 'F1', label: 'F₁' },
  { id: 'F2', label: 'F₂' },
  { id: 'F3', label: 'F₃' },
  { id: 'FA', label: 'F_A' },
  { id: 'FD', label: 'F_D' },
  { id: 'FIBER', label: 'FIBER' },
  { id: 'ALL', label: 'ALL' },
];

/* ------------------------------------------------------------------ *
 * Public computation helpers (used by loader during eager prep)
 * ------------------------------------------------------------------ */
export function channelEnergyForPly(plyModes, channelIndex) {
  const start = channelIndex * 64;
  let energy = 0;
  for (let i = start; i < start + 64; i++) energy += plyModes[i] * plyModes[i];
  return energy;
}

/**
 * Build the 8×8 overlay payload for the currently-selected channel at a given
 * ply, optionally passed through a perceptual transform. Returns null when
 * there is no single 64-vector to project (ALL / FIBER views) or when
 * spectral data isn't ready yet.
 *
 * Transforms:
 *   'abs'   — raw mode coefficients; absMax matches js/spectral.js heatmap
 *             so 1-D ↔ 2-D color parity holds (the original mode).
 *   'delta' — spec[p] - spec[p-1] per mode (option C: the "force"/gradient
 *             view; tells you how the channel reacted to the move just
 *             played). At p=0 every cell is 0 → fully transparent.
 *   'log'   — sign-preserving log1p compression: emphasizes small/medium
 *             cells without losing the saturated peaks. Useful when one or
 *             two modes dominate the absolute view.
 *   'z'     — per-square temporal z-score against this game's per-mode
 *             mean/σ; clipped to ±3σ. Highlights moments where a square is
 *             unusually energetic *for this specific game* rather than its
 *             absolute magnitude.
 *
 * Per-channel/per-game stats (delta absMax, per-mode μ/σ, log scale) are
 * computed once and cached on `game.spectral._overlayCache`.
 */
export const OVERLAY_TRANSFORM_IDS = ['abs', 'delta', 'log', 'z'];
export const OVERLAY_TRANSFORM_LABELS = {
  abs: 'abs', delta: 'Δply', log: 'log', z: 'z',
};

function _getOverlayCache(game, channelId) {
  const sp = game.spectral;
  if (!sp._overlayCache) sp._overlayCache = {};
  if (sp._overlayCache[channelId]) return sp._overlayCache[channelId];

  const ch = CHANNEL_BY_ID[channelId];
  const { plies, nPlies, valueMinMax } = sp;
  const start = ch.index * 64;

  const r = valueMinMax?.[channelId] || { min: 0, max: 0 };
  const rawAbsMax = Math.max(Math.abs(r.min), Math.abs(r.max), 1e-9);

  // Δply absMax: max |spec[p] - spec[p-1]| over all p>=1, m
  let deltaAbsMax = 1e-9;
  for (let p = 1; p < nPlies; p++) {
    const cur = plies[p], prev = plies[p - 1];
    for (let m = 0; m < 64; m++) {
      const d = Math.abs(cur[start + m] - prev[start + m]);
      if (d > deltaAbsMax) deltaAbsMax = d;
    }
  }

  // Per-mode μ, σ across plies for z-score
  const mean = new Float32Array(64);
  const std  = new Float32Array(64);
  for (let m = 0; m < 64; m++) {
    let sum = 0;
    for (let p = 0; p < nPlies; p++) sum += plies[p][start + m];
    mean[m] = sum / Math.max(1, nPlies);
    let v2 = 0;
    for (let p = 0; p < nPlies; p++) {
      const d = plies[p][start + m] - mean[m];
      v2 += d * d;
    }
    std[m] = Math.sqrt(v2 / Math.max(1, nPlies)) || 1;
  }

  // Log compression: choose k so log1p(rawAbsMax/k) maps the peak to a
  // moderate value; k = rawAbsMax/4 keeps the curve nearly linear near 0
  // and squashes the upper tail.
  const logK = Math.max(1e-9, rawAbsMax / 4);
  const logAbsMax = Math.log1p(rawAbsMax / logK);

  const cache = { rawAbsMax, deltaAbsMax, mean, std, logK, logAbsMax };
  sp._overlayCache[channelId] = cache;
  return cache;
}

export function getOverlayForPly(game, ply, heatmapView, transform = 'abs') {
  if (!game || !game.spectral) return null;
  const ch = CHANNEL_BY_ID[heatmapView];
  if (!ch) return null;  // ALL / FIBER have no single channel
  const { plies, nPlies } = game.spectral;
  if (!plies || nPlies <= 0) return null;
  const p = Math.max(0, Math.min(nPlies - 1, ply | 0));
  const modes = plies[p];
  if (!modes) return null;

  const start = ch.index * 64;
  const cache = _getOverlayCache(game, ch.id);
  const bySquare = new Float32Array(64);
  let absMax = cache.rawAbsMax;
  const mode = OVERLAY_TRANSFORM_IDS.includes(transform) ? transform : 'abs';

  switch (mode) {
    case 'delta': {
      absMax = cache.deltaAbsMax;
      const prev = p > 0 ? plies[p - 1] : null;
      if (prev) {
        for (let m = 0; m < 64; m++) bySquare[m] = modes[start + m] - prev[start + m];
      }
      // p === 0 → bySquare stays all zeros (fully transparent overlay)
      break;
    }
    case 'log': {
      absMax = cache.logAbsMax;
      const k = cache.logK;
      for (let m = 0; m < 64; m++) {
        const v = modes[start + m];
        bySquare[m] = (v < 0 ? -1 : v > 0 ? 1 : 0) * Math.log1p(Math.abs(v) / k);
      }
      break;
    }
    case 'z': {
      absMax = 3;  // ±3σ saturates; further is clamped at the renderer
      for (let m = 0; m < 64; m++) {
        bySquare[m] = (modes[start + m] - cache.mean[m]) / cache.std[m];
      }
      break;
    }
    case 'abs':
    default: {
      absMax = cache.rawAbsMax;
      for (let m = 0; m < 64; m++) bySquare[m] = modes[start + m];
      break;
    }
  }

  return {
    channelId: ch.id,
    channelLabel: ch.label,
    transform: mode,
    transformLabel: OVERLAY_TRANSFORM_LABELS[mode],
    bySquare,
    absMax,
  };
}

/** Parse a Lichess-style eval string. "+0.18" → 0.18, "-1.50" → -1.50,
 *  "#3" → +10 (mate clamp), "#-2" → -10. Returns null if unparseable. */
export function parseEvalString(s) {
  if (s == null) return null;
  s = String(s).trim();
  if (!s) return null;
  if (s.startsWith('#')) {
    const sign = s[1] === '-' ? -1 : 1;
    return sign * 10;
  }
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : null;
}

/* ------------------------------------------------------------------ *
 * Heatmap renderer
 * ------------------------------------------------------------------ */
const heatmap = {
  canvas: null,
  ctx: null,
  overlay: null,           // SVG element
  host: null,
  tooltip: null,

  // Cached render state
  game: null,
  view: null,
  imageBitmap: null,       // off-screen ImageBitmap of the heatmap
  rowsByChannel: null,     // for ALL/FIBER: row index → channel id
  cellH: 1,
  cellW: 1,
  drawWidth: 0,
  drawHeight: 0,
  paddingTop: 14,
  paddingLeft: 60,
  paddingRight: 12,
  paddingBottom: 22,
  contentHeight: 0,        // pixel height of the heatmap content area
  contentWidth: 0,

  // Off-screen canvas cache. Painting the per-pixel ImageData is the
  // expensive part of renderHeatmap (O(nPlies × totalRows)); resize-only
  // re-renders can reuse the bitmap and just blit at the new size.
  // Keyed by (view, nPlies, totalRows) plus an identity check on the
  // spectral object reference so a game change, view toggle, or
  // LRU-evicted spectral re-parse all invalidate it correctly.
  offCanvas: null,
  offKey: null,
  offSpectralRef: null,
};

export function initHeatmap(rootIds = {
  host: 'heatmap-host',
  canvas: 'heatmap-canvas',
  overlay: 'heatmap-overlay',
  tooltip: 'heatmap-tooltip',
  togglesHost: 'channel-toggles',
}) {
  heatmap.host = document.getElementById(rootIds.host);
  heatmap.canvas = document.getElementById(rootIds.canvas);
  heatmap.ctx = heatmap.canvas.getContext('2d', { alpha: false });
  heatmap.overlay = document.getElementById(rootIds.overlay);
  heatmap.tooltip = document.getElementById(rootIds.tooltip);

  buildChannelToggles(document.getElementById(rootIds.togglesHost));

  // Mouse interactions
  heatmap.canvas.style.pointerEvents = 'auto';
  heatmap.canvas.addEventListener('mousemove', onHeatmapMouseMove);
  heatmap.canvas.addEventListener('mouseleave', () => (heatmap.tooltip.hidden = true));
  heatmap.canvas.addEventListener('click', onHeatmapClick);

  subscribe('game', renderHeatmap);
  subscribe('heatmapView', renderHeatmap);
  subscribe('ply', updatePlyIndicator);

  // Re-render on resize
  const ro = new ResizeObserver(() => renderHeatmap());
  ro.observe(heatmap.host);

  // Re-render once web fonts have settled — channel/axis labels change
  // metrics when the JetBrains Mono swap-in completes.
  if (document.fonts?.ready) document.fonts.ready.then(() => renderHeatmap());

  // Initial render (deferred until corpus is ready)
}

function buildChannelToggles(hostEl) {
  hostEl.innerHTML = '';
  for (const v of HEATMAP_VIEWS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chan-btn';
    const ch = CHANNEL_BY_ID[v.id];
    b.style.setProperty('--c', ch ? ch.color : 'var(--accent)');
    b.textContent = v.label;
    b.dataset.view = v.id;
    b.addEventListener('click', () => setState({ heatmapView: v.id }));
    hostEl.appendChild(b);
  }
  subscribe('heatmapView', () => {
    for (const btn of hostEl.querySelectorAll('.chan-btn')) {
      btn.classList.toggle('active', btn.dataset.view === state.heatmapView);
    }
  });
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */
function renderHeatmap() {
  const game = getActiveGame();
  if (!game || !game.spectral) {
    return;
  }
  heatmap.game = game;
  heatmap.view = state.heatmapView;

  const { plies, nPlies } = game.spectral;
  const view = state.heatmapView;

  // Determine row layout
  let rowChannels;       // array of channel IDs, in stack order top→bottom
  if (view === 'ALL')        rowChannels = CHANNELS.map((c) => c.id);
  else if (view === 'FIBER') rowChannels = ['F1', 'F2', 'F3'];
  else                       rowChannels = [view];

  heatmap.rowsByChannel = rowChannels;

  const totalRows = rowChannels.length * 64;

  // Layout the panel
  const rect = heatmap.host.getBoundingClientRect();
  // Defer until layout has produced real dimensions — drawing into a
  // 100x100 fallback box would leave the canvas visibly stale until any
  // later interaction triggered a re-render.
  if (rect.width < 50 || rect.height < 50) {
    requestAnimationFrame(() => renderHeatmap());
    return;
  }
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = rect.width;
  const h = rect.height;

  heatmap.canvas.width = Math.round(w * dpr);
  heatmap.canvas.height = Math.round(h * dpr);
  heatmap.canvas.style.width = w + 'px';
  heatmap.canvas.style.height = h + 'px';
  heatmap.overlay.setAttribute('viewBox', `0 0 ${w} ${h}`);
  heatmap.overlay.setAttribute('width', w);
  heatmap.overlay.setAttribute('height', h);

  const padL = 60;
  const padR = 12;
  const padT = 12;
  const padB = 22;
  const contentW = Math.max(20, w - padL - padR);
  const contentH = Math.max(20, h - padT - padB);

  heatmap.paddingLeft = padL;
  heatmap.paddingRight = padR;
  heatmap.paddingTop = padT;
  heatmap.paddingBottom = padB;
  heatmap.contentWidth = contentW;
  heatmap.contentHeight = contentH;

  // Off-screen image at native cell resolution. Reused across resize-only
  // re-renders — only rebuilt when game / view / shape change. Identity is
  // tracked by the spectral object reference so an LRU re-parse (which
  // produces a fresh ArrayBuffer + Float32Array views for the same game
  // index) correctly invalidates the cache.
  const offKey = `${view}|${nPlies}|${totalRows}`;
  let off = heatmap.offCanvas;
  if (!off || heatmap.offKey !== offKey
      || heatmap.offSpectralRef !== game.spectral
      || off.width !== nPlies || off.height !== totalRows) {
    off = document.createElement('canvas');
    off.width = nPlies;
    off.height = totalRows;
    const offCtx = off.getContext('2d');
    const img = offCtx.createImageData(nPlies, totalRows);

    // For each row's channel, get its global value range
    const ranges = rowChannels.map((id) => {
      const r = game.spectral.valueMinMax[id];
      const m = Math.max(Math.abs(r.min), Math.abs(r.max), 1e-9);
      return { id, abs: m };
    });

    for (let rowChIdx = 0; rowChIdx < rowChannels.length; rowChIdx++) {
      const chId = rowChannels[rowChIdx];
      const ch = CHANNEL_BY_ID[chId];
      const startMode = ch.index * 64;
      const absMax = ranges[rowChIdx].abs;

      for (let m = 0; m < 64; m++) {
        const y = rowChIdx * 64 + m;
        for (let p = 0; p < nPlies; p++) {
          const v = plies[p][startMode + m];
          const t = Math.max(-1, Math.min(1, v / absMax));
          const [r, g, b] = divergingColor(t);
          const off4 = (y * nPlies + p) * 4;
          img.data[off4]     = r;
          img.data[off4 + 1] = g;
          img.data[off4 + 2] = b;
          img.data[off4 + 3] = 255;
        }
      }
    }
    offCtx.putImageData(img, 0, 0);

    heatmap.offCanvas = off;
    heatmap.offKey = offKey;
    heatmap.offSpectralRef = game.spectral;
  }

  // Draw to main canvas (background fill first)
  const ctx = heatmap.ctx;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0a0a0f';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(off, padL, padT, contentW, contentH);

  heatmap.cellW = contentW / nPlies;
  heatmap.cellH = contentH / totalRows;

  // Build SVG overlay (axes, channel labels, ply indicator)
  drawOverlay(rowChannels, nPlies, padL, padT, padB, padR, contentW, contentH, w, h);

  // Update ply indicator (re-uses overlay)
  updatePlyIndicator();

  // Update meta line
  const meta = document.getElementById('heatmap-meta');
  if (meta) {
    if (rowChannels.length === 1) {
      const ch = CHANNEL_BY_ID[rowChannels[0]];
      const r = game.spectral.valueMinMax[ch.id];
      meta.textContent = `${ch.label} · ${nPlies} plies × 64 modes · range [${r.min.toFixed(3)}, ${r.max.toFixed(3)}]`;
    } else {
      meta.textContent = `${view} · ${nPlies} plies × ${rowChannels.length}×64 modes`;
    }
  }
}

/* ------------------------------------------------------------------ *
 * Overlay (SVG): axes, channel labels, ply indicator
 * ------------------------------------------------------------------ */
function drawOverlay(rowChannels, nPlies, padL, padT, padB, padR, contentW, contentH, w, h) {
  const svg = heatmap.overlay;
  while (svg.firstChild) svg.removeChild(svg.firstChild);

  const NS = 'http://www.w3.org/2000/svg';
  const totalRows = rowChannels.length * 64;
  const rowH = contentH / totalRows;

  // Y-axis: per-channel labels + dividers
  for (let i = 0; i < rowChannels.length; i++) {
    const chId = rowChannels[i];
    const ch = CHANNEL_BY_ID[chId];
    const yTop = padT + i * 64 * rowH;
    const yMid = yTop + 32 * rowH;

    // Divider above (skip first)
    if (i > 0) {
      const ln = document.createElementNS(NS, 'line');
      ln.setAttribute('x1', padL);
      ln.setAttribute('x2', padL + contentW);
      ln.setAttribute('y1', yTop);
      ln.setAttribute('y2', yTop);
      ln.setAttribute('class', 'channel-divider');
      svg.appendChild(ln);
    }

    // Channel label (centered on its band)
    const lbl = document.createElementNS(NS, 'text');
    lbl.setAttribute('x', padL - 8);
    lbl.setAttribute('y', yMid + 3);
    lbl.setAttribute('text-anchor', 'end');
    lbl.setAttribute('class', 'group-label');
    lbl.setAttribute('fill', ch.color);
    lbl.textContent = ch.label;
    svg.appendChild(lbl);

    // Mode tick (top, mid, bottom of each band)
    if (rowChannels.length === 1) {
      for (const m of [0, 16, 32, 48, 63]) {
        const ty = yTop + (m + 0.5) * rowH;
        const t = document.createElementNS(NS, 'text');
        t.setAttribute('x', padL - 36);
        t.setAttribute('y', ty + 3);
        t.setAttribute('text-anchor', 'end');
        t.textContent = m;
        svg.appendChild(t);
      }
    }
  }

  // X-axis: ply ticks
  const xTickStep = chooseTickStep(nPlies);
  for (let p = 0; p <= nPlies; p += xTickStep) {
    const x = padL + (p / nPlies) * contentW;
    const t = document.createElementNS(NS, 'text');
    t.setAttribute('x', x);
    t.setAttribute('y', padT + contentH + 14);
    t.setAttribute('text-anchor', 'middle');
    t.textContent = p;
    svg.appendChild(t);
  }
  // X-axis baseline
  const baseLine = document.createElementNS(NS, 'line');
  baseLine.setAttribute('x1', padL);
  baseLine.setAttribute('x2', padL + contentW);
  baseLine.setAttribute('y1', padT + contentH + 0.5);
  baseLine.setAttribute('y2', padT + contentH + 0.5);
  baseLine.setAttribute('stroke', 'rgba(255,255,255,0.16)');
  svg.appendChild(baseLine);

  // Ply indicator placeholder (updated in updatePlyIndicator)
  const ind = document.createElementNS(NS, 'line');
  ind.setAttribute('id', 'heatmap-ply-line');
  ind.setAttribute('class', 'ply-indicator');
  ind.setAttribute('y1', padT);
  ind.setAttribute('y2', padT + contentH);
  ind.setAttribute('x1', padL);
  ind.setAttribute('x2', padL);
  svg.appendChild(ind);
}

function chooseTickStep(n) {
  if (n <= 20) return 2;
  if (n <= 60) return 5;
  if (n <= 150) return 10;
  if (n <= 400) return 25;
  return 50;
}

function updatePlyIndicator() {
  if (!heatmap.game) return;
  const line = document.getElementById('heatmap-ply-line');
  if (!line) return;
  const { nPlies } = heatmap.game.spectral;
  const ply = Math.max(0, Math.min(nPlies - 1, state.currentPly));
  const x = heatmap.paddingLeft + ((ply + 0.5) / nPlies) * heatmap.contentWidth;
  line.setAttribute('x1', x);
  line.setAttribute('x2', x);
}

/* ------------------------------------------------------------------ *
 * Mouse interactions
 * ------------------------------------------------------------------ */
function hitTest(evt) {
  if (!heatmap.game) return null;
  const rect = heatmap.canvas.getBoundingClientRect();
  const x = evt.clientX - rect.left;
  const y = evt.clientY - rect.top;
  if (x < heatmap.paddingLeft || x > heatmap.paddingLeft + heatmap.contentWidth) return null;
  if (y < heatmap.paddingTop  || y > heatmap.paddingTop  + heatmap.contentHeight) return null;

  const { nPlies } = heatmap.game.spectral;
  const totalRows = heatmap.rowsByChannel.length * 64;
  // Clamp to valid index range — at the canvas's right/bottom edge the raw
  // floor() would land on nPlies / totalRows and crash the plies[] lookup.
  const rawPly = Math.floor((x - heatmap.paddingLeft) / heatmap.contentWidth * nPlies);
  const rawRow = Math.floor((y - heatmap.paddingTop)  / heatmap.contentHeight * totalRows);
  const ply = Math.max(0, Math.min(nPlies - 1, rawPly));
  const row = Math.max(0, Math.min(totalRows - 1, rawRow));

  const chIndex = Math.floor(row / 64);
  const modeInChannel = row % 64;
  const chId = heatmap.rowsByChannel[chIndex];
  const ch = CHANNEL_BY_ID[chId];
  const value = heatmap.game.spectral.plies[ply][ch.index * 64 + modeInChannel];
  return { ply, channel: ch, mode: modeInChannel, value };
}

function onHeatmapMouseMove(evt) {
  const hit = hitTest(evt);
  if (!hit) {
    heatmap.tooltip.hidden = true;
    return;
  }
  const tt = heatmap.tooltip;
  tt.hidden = false;
  const energy = hit.value * hit.value;
  tt.innerHTML =
    `<span class="swatch" style="background:${hit.channel.color}"></span>` +
    `<strong>${hit.channel.label}</strong> · mode ${hit.mode}\n` +
    `ply ${hit.ply}    value ${formatNum(hit.value)}\n` +
    `energy contribution ${formatNum(energy)}`;
  // Position relative to host
  const hostRect = heatmap.host.getBoundingClientRect();
  tt.style.left = (evt.clientX - hostRect.left) + 'px';
  tt.style.top  = (evt.clientY - hostRect.top)  + 'px';
}

function onHeatmapClick(evt) {
  const hit = hitTest(evt);
  if (!hit) return;
  setState({ currentPly: hit.ply });
}

/* ------------------------------------------------------------------ *
 * Color scale — diverging, dark-background friendly
 * ------------------------------------------------------------------ */
// Maps t ∈ [-1, +1] → [r,g,b] (0..255).
// Negative → cyan, zero → near-black, positive → amber/orange.
// Exported so the board overlay (js/board.js → js/chess-overlay.js,
// js/othello-board.js) can paint squares with byte-identical colors to the
// matching heatmap cell.
export function divergingColor(t) {
  const a = Math.min(1, Math.abs(t));
  // intensity curve: emphasize low magnitudes a touch (sqrt)
  const k = Math.sqrt(a);
  if (t < 0) {
    // background → cyan/blue
    const r = Math.round(10 * (1 - k) + 10  * k);
    const g = Math.round(10 * (1 - k) + 200 * k);
    const b = Math.round(15 * (1 - k) + 255 * k);
    return [r, g, b];
  } else {
    // background → amber
    const r = Math.round(10 * (1 - k) + 255 * k);
    const g = Math.round(10 * (1 - k) + 180 * k);
    const b = Math.round(15 * (1 - k) +  60 * k);
    return [r, g, b];
  }
}

function formatNum(v) {
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1000) return v.toExponential(2);
  if (a >= 1)    return v.toFixed(3);
  if (a >= 0.001) return v.toFixed(4);
  return v.toExponential(2);
}

/* Public re-render hook for app.js to call after corpus initially loads. */
export function refreshHeatmap() {
  renderHeatmap();
}
