/* charts.js — D3 channel-energy line chart with eval overlay.
 *
 * State sources (read live from app.js):
 *   - state.activeChannels  Set<string>   IDs to plot as traces
 *   - state.currentPly      number        for crosshair indicator
 *   - state.chartScale      'z'|'log'|'linear'
 *   - state.evalOverlay     boolean
 */

import { state, on as subscribe, set as setState, getActiveGame } from './app.js';
import {
  CHANNELS,
  CHANNEL_BY_ID,
  DERIVED_CHANNELS,
  parseEvalString,
} from './spectral.js';

const PLOTTABLE = [...CHANNELS, ...DERIVED_CHANNELS];
const PLOTTABLE_BY_ID = Object.fromEntries(PLOTTABLE.map((c) => [c.id, c]));

const chart = {
  svg: null,
  host: null,
  tooltip: null,
  togglesHost: null,
  margin: { top: 14, right: 56, bottom: 28, left: 56 },
  game: null,
  evalSeries: null,   // [{ply, val}]
};

export function initChart(ids = {
  host: 'chart-host',
  svg: 'chart-svg',
  tooltip: 'chart-tooltip',
  togglesHost: 'chart-channel-toggles',
  evalToggle: 'eval-overlay-toggle',
}) {
  chart.host = document.getElementById(ids.host);
  chart.svg = d3.select('#' + ids.svg);
  chart.tooltip = document.getElementById(ids.tooltip);
  chart.togglesHost = document.getElementById(ids.togglesHost);

  buildToggles(chart.togglesHost);

  // Y-scale segmented control
  document.querySelectorAll('.seg-control [data-scale]').forEach((btn) => {
    btn.addEventListener('click', () => setState({ chartScale: btn.dataset.scale }));
  });
  subscribe('chartScale', () => {
    document.querySelectorAll('.seg-control [data-scale]').forEach((btn) => {
      const active = btn.dataset.scale === state.chartScale;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    renderChart();
  });

  // Eval overlay toggle
  const evalBox = document.getElementById(ids.evalToggle);
  if (evalBox) {
    evalBox.checked = state.evalOverlay;
    evalBox.addEventListener('change', () => setState({ evalOverlay: evalBox.checked }));
  }
  subscribe('evalOverlay', renderChart);

  subscribe('game', () => {
    chart.evalSeries = null;
    renderChart();
  });
  subscribe('activeChannels', renderChart);
  subscribe('ply', updatePlyIndicator);

  // Re-render once web fonts have settled — font swaps shift text metrics
  // and can leave axis labels mis-measured if we drew before they loaded.
  if (document.fonts?.ready) document.fonts.ready.then(() => renderChart());

  const ro = new ResizeObserver(() => renderChart());
  ro.observe(chart.host);

  // Mouse tracking
  chart.svg.on('mousemove', onMouseMove);
  chart.svg.on('mouseleave', () => (chart.tooltip.hidden = true));
  chart.svg.on('click', onClick);
}

function buildToggles(hostEl) {
  hostEl.innerHTML = '';
  for (const ch of PLOTTABLE) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'chan-btn';
    b.style.setProperty('--c', ch.color);
    b.textContent = ch.label;
    b.dataset.id = ch.id;
    b.title = ch.desc || ch.id;
    b.addEventListener('click', () => {
      const next = new Set(state.activeChannels);
      if (next.has(ch.id)) next.delete(ch.id);
      else next.add(ch.id);
      setState({ activeChannels: next });
    });
    hostEl.appendChild(b);
  }
  subscribe('activeChannels', () => {
    for (const btn of hostEl.querySelectorAll('.chan-btn')) {
      btn.classList.toggle('active', state.activeChannels.has(btn.dataset.id));
    }
  });
}

/* ------------------------------------------------------------------ *
 * Render
 * ------------------------------------------------------------------ */
function renderChart() {
  const game = getActiveGame();
  if (!game || !game.spectral) return;
  chart.game = game;

  // Compute eval series once per game
  if (!chart.evalSeries) {
    chart.evalSeries = game.plies.map((p) => {
      const v = parseEvalString(p.eval);
      return v == null ? null : { ply: p.ply, val: v };
    }).filter(Boolean);
  }

  // Measure the SVG's rendered box (which is positioned via CSS inside
  // chart-host). We set only viewBox and let CSS drive the on-screen size,
  // so the SVG can't feed its own size back into the host's intrinsic
  // height (which would cause an unbounded ResizeObserver growth loop in
  // an auto-sized grid row).
  const rect = chart.svg.node().getBoundingClientRect();
  // If the SVG hasn't been laid out yet (e.g. we were called before the
  // browser performed its first layout pass after viewer reveal), defer
  // the render to the next animation frame rather than drawing into a
  // stale 100x100 fallback box that the user would see as a squished
  // chart until any other interaction triggered a re-render.
  if (rect.width < 50 || rect.height < 50) {
    requestAnimationFrame(() => renderChart());
    return;
  }
  const w = rect.width;
  const h = rect.height;

  chart.svg
    .attr('viewBox', `0 0 ${w} ${h}`)
    .attr('preserveAspectRatio', 'none');

  chart.svg.selectAll('*').remove();

  const m = chart.margin;
  const innerW = Math.max(20, w - m.left - m.right);
  const innerH = Math.max(20, h - m.top - m.bottom);
  const root = chart.svg.append('g').attr('transform', `translate(${m.left},${m.top})`);

  const { nPlies, channelEnergies, stats } = game.spectral;
  const xScale = d3.scaleLinear().domain([0, nPlies - 1]).range([0, innerW]);

  // Determine traces
  const ids = [...state.activeChannels].filter((id) => PLOTTABLE_BY_ID[id]);
  if (ids.length === 0) {
    root.append('text')
      .attr('x', innerW / 2).attr('y', innerH / 2)
      .attr('text-anchor', 'middle')
      .attr('fill', 'var(--fg-3)')
      .text('Select one or more channels');
    return;
  }

  // Compute y-scale
  let yScale;
  let yAccessor;
  if (state.chartScale === 'z') {
    let mx = 0;
    for (const id of ids) {
      const arr = channelEnergies[id];
      const { mean, sigma } = stats[id];
      for (let i = 0; i < arr.length; i++) {
        const z = (arr[i] - mean) / sigma;
        if (Math.abs(z) > mx) mx = Math.abs(z);
      }
    }
    mx = Math.max(1, mx);
    yScale = d3.scaleLinear().domain([-mx * 1.05, mx * 1.05]).range([innerH, 0]);
    yAccessor = (id, p) => (channelEnergies[id][p] - stats[id].mean) / stats[id].sigma;
  } else if (state.chartScale === 'log') {
    let mn = Infinity, mx = -Infinity;
    for (const id of ids) {
      const arr = channelEnergies[id];
      for (let i = 0; i < arr.length; i++) {
        const v = arr[i];
        if (v > 0 && v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    if (!Number.isFinite(mn)) mn = 1e-3;
    if (!Number.isFinite(mx)) mx = 1;
    yScale = d3.scaleLog().domain([mn * 0.8, mx * 1.2]).range([innerH, 0]);
    yAccessor = (id, p) => Math.max(1e-12, channelEnergies[id][p]);
  } else {
    let mx = 0;
    for (const id of ids) {
      const arr = channelEnergies[id];
      for (let i = 0; i < arr.length; i++) if (arr[i] > mx) mx = arr[i];
    }
    if (mx === 0) mx = 1;
    yScale = d3.scaleLinear().domain([0, mx * 1.05]).range([innerH, 0]);
    yAccessor = (id, p) => channelEnergies[id][p];
  }

  // Grid
  const yTicks = yScale.ticks(5);
  root.append('g').attr('class', 'grid')
    .selectAll('line').data(yTicks).enter().append('line')
    .attr('x1', 0).attr('x2', innerW)
    .attr('y1', (d) => yScale(d)).attr('y2', (d) => yScale(d));

  // Axes
  root.append('g').attr('class', 'axis')
    .attr('transform', `translate(0,${innerH})`)
    .call(d3.axisBottom(xScale).ticks(Math.min(10, nPlies)).tickSizeOuter(0));
  root.append('g').attr('class', 'axis')
    .call(d3.axisLeft(yScale).ticks(5).tickSizeOuter(0));

  // Y-axis label
  root.append('text')
    .attr('x', -m.left + 6).attr('y', -2)
    .attr('fill', 'var(--fg-3)').attr('font-size', 10)
    .text(state.chartScale === 'z' ? 'σ' : (state.chartScale === 'log' ? 'log(E)' : 'energy'));

  // Eval overlay (right-axis)
  let evalScale = null;
  if (state.evalOverlay && chart.evalSeries.length > 0) {
    let mx = 0;
    for (const e of chart.evalSeries) if (Math.abs(e.val) > mx) mx = Math.abs(e.val);
    mx = Math.max(0.5, mx);
    evalScale = d3.scaleLinear().domain([-mx * 1.05, mx * 1.05]).range([innerH, 0]);
    root.append('g').attr('class', 'axis')
      .attr('transform', `translate(${innerW},0)`)
      .call(d3.axisRight(evalScale).ticks(4).tickSizeOuter(0));
    root.append('text')
      .attr('x', innerW + 6).attr('y', -2)
      .attr('fill', 'var(--fg-3)').attr('font-size', 10)
      .text('eval');

    // Zero baseline
    root.append('line')
      .attr('x1', 0).attr('x2', innerW)
      .attr('y1', evalScale(0)).attr('y2', evalScale(0))
      .attr('stroke', 'rgba(255,255,255,0.06)')
      .attr('stroke-dasharray', '2 2');

    const evalLine = d3.line()
      .x((d) => xScale(d.ply))
      .y((d) => evalScale(d.val))
      .curve(d3.curveMonotoneX);
    root.append('path')
      .datum(chart.evalSeries)
      .attr('class', 'eval-line')
      .attr('d', evalLine);
  }

  // Traces
  for (const id of ids) {
    const ch = PLOTTABLE_BY_ID[id];
    const data = d3.range(nPlies).map((p) => ({ p, v: yAccessor(id, p) }));
    const line = d3.line()
      .x((d) => xScale(d.p))
      .y((d) => yScale(d.v))
      .defined((d) => Number.isFinite(d.v))
      .curve(d3.curveMonotoneX);
    root.append('path')
      .datum(data)
      .attr('class', 'trace')
      .attr('stroke', ch.color)
      .attr('d', line);
  }

  // Ply indicator
  root.append('line')
    .attr('id', 'chart-ply-line')
    .attr('class', 'ply-indicator')
    .attr('y1', 0).attr('y2', innerH);
  updatePlyIndicator();

  // Stash for hover
  chart._innerW = innerW;
  chart._innerH = innerH;
  chart._xScale = xScale;
  chart._yScale = yScale;
  chart._yAccessor = yAccessor;
  chart._activeIds = ids;
  chart._evalScale = evalScale;
}

function updatePlyIndicator() {
  if (!chart.game || !chart._xScale) return;
  const x = chart._xScale(state.currentPly);
  d3.select('#chart-ply-line')
    .attr('x1', x)
    .attr('x2', x);
}

/* ------------------------------------------------------------------ *
 * Mouse interactions
 * ------------------------------------------------------------------ */
function clientToLocalPly(evt) {
  if (!chart.game || !chart._xScale) return null;
  const rect = chart.svg.node().getBoundingClientRect();
  const m = chart.margin;
  const xPx = evt.clientX - rect.left - m.left;
  if (xPx < 0 || xPx > chart._innerW) return null;
  const ply = Math.round(chart._xScale.invert(xPx));
  return Math.max(0, Math.min(chart.game.spectral.nPlies - 1, ply));
}

function onMouseMove(evt) {
  const ply = clientToLocalPly(evt);
  if (ply == null) {
    chart.tooltip.hidden = true;
    return;
  }
  const tt = chart.tooltip;
  tt.hidden = false;
  const lines = [`ply ${ply}`];
  for (const id of chart._activeIds) {
    const ch = PLOTTABLE_BY_ID[id];
    const v = chart.game.spectral.channelEnergies[id][ply];
    lines.push(
      `<span class="swatch" style="background:${ch.color}"></span>${ch.label}: ${formatNum(v)}`
    );
  }
  // Eval if available at that ply
  if (state.evalOverlay) {
    const e = chart.game.plies[ply] && parseEvalString(chart.game.plies[ply].eval);
    if (e != null) lines.push(`eval ${e > 0 ? '+' : ''}${e.toFixed(2)}`);
  }
  tt.innerHTML = lines.join('\n');
  const hostRect = chart.host.getBoundingClientRect();
  tt.style.left = (evt.clientX - hostRect.left) + 'px';
  tt.style.top  = (evt.clientY - hostRect.top)  + 'px';
}

function onClick(evt) {
  const ply = clientToLocalPly(evt);
  if (ply == null) return;
  setState({ currentPly: ply });
}

function formatNum(v) {
  if (!Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a === 0) return '0';
  if (a >= 1e4) return v.toExponential(2);
  if (a >= 1)   return v.toFixed(2);
  if (a >= 0.01) return v.toFixed(3);
  return v.toExponential(2);
}

export function refreshChart() {
  renderChart();
}
