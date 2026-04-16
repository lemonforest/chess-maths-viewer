/* virtual-table.js — DIY virtual scroller for a <table> with sticky header.
 *
 * Renders only the currently-visible rows (plus a small overscan) into
 * <tbody>, padded above and below with two oversized spacer <tr>s so the
 * scrollbar still reflects the full item count.
 *
 * Assumes a fixed row height, which we measure once at init from a real
 * rendered row so we don't hard-code CSS pixel values.
 *
 * Usage:
 *   const vt = createVirtualTable({
 *     viewport,         // scrollable ancestor of the table
 *     tbody,            // <tbody> element to render rows into
 *     renderRow,        // (item, index) => <tr> element
 *     keyFn,            // (item) => primary key (e.g. item.index)
 *     overscan = 10,
 *   });
 *   vt.setItems(arr);   // initial or re-sorted data
 *   vt.setActive(key);  // highlight row (toggles .active class)
 *   vt.scrollToKey(k);  // bring a row into view
 *   vt.rerender();      // force re-render (e.g. after resize)
 */

export function createVirtualTable({
  viewport,
  tbody,
  renderRow,
  keyFn,
  overscan = 10,
}) {
  if (!viewport || !tbody) throw new Error('virtual-table: viewport and tbody required');

  const state = {
    items: [],
    activeKey: null,
    rowHeight: 0,
    topPad: null,       // <tr class="vt-pad vt-pad-top">
    botPad: null,       // <tr class="vt-pad vt-pad-bot">
    renderedRange: { start: -1, end: -1 },
    rafPending: false,
    columnCount: 0,     // colspan for pad rows (measured from table header)
  };

  function measureColumnCount() {
    const thead = tbody.parentElement && tbody.parentElement.querySelector('thead tr');
    state.columnCount = thead ? thead.children.length : 1;
  }

  function measureRowHeight() {
    // Render one dummy row, measure, remove. If the table is empty this
    // falls back to a reasonable 27px (matches current viewer.css:
    // 6px top + 6px bottom padding, 12px font, 1px border).
    if (!state.items.length) { state.rowHeight = 27; return; }
    const probe = renderRow(state.items[0], 0);
    probe.style.visibility = 'hidden';
    tbody.innerHTML = '';
    tbody.appendChild(probe);
    const h = probe.getBoundingClientRect().height;
    state.rowHeight = Math.max(1, Math.round(h || 27));
    tbody.removeChild(probe);
  }

  function buildPadRows() {
    const cc = state.columnCount || 1;
    const mk = (cls) => {
      const tr = document.createElement('tr');
      tr.className = 'vt-pad ' + cls;
      tr.innerHTML = `<td colspan="${cc}" style="padding:0;border:0;height:0"></td>`;
      return tr;
    };
    state.topPad = mk('vt-pad-top');
    state.botPad = mk('vt-pad-bot');
  }

  function setPadHeights(topPx, botPx) {
    state.topPad.firstElementChild.style.height = topPx + 'px';
    state.botPad.firstElementChild.style.height = botPx + 'px';
  }

  function visibleWindow() {
    const scrollTop = viewport.scrollTop;
    const vh = viewport.clientHeight;
    const rh = state.rowHeight;
    const total = state.items.length;
    const first = Math.max(0, Math.floor(scrollTop / rh) - overscan);
    const visible = Math.ceil(vh / rh) + overscan * 2;
    const last = Math.min(total, first + visible);
    return { first, last };
  }

  function render() {
    state.rafPending = false;
    if (!state.items.length) {
      tbody.innerHTML = '';
      state.renderedRange = { start: -1, end: -1 };
      return;
    }

    const { first, last } = visibleWindow();
    const prev = state.renderedRange;
    if (first === prev.start && last === prev.end) {
      // Window unchanged — just ensure active row highlight is current.
      applyActiveToRenderedRows();
      return;
    }

    // Rebuild the visible window. At ~35 rows this is O(35) — well
    // under a frame even on mid-range hardware.
    tbody.innerHTML = '';
    tbody.appendChild(state.topPad);
    for (let i = first; i < last; i++) {
      const item = state.items[i];
      const tr = renderRow(item, i);
      const k = keyFn(item);
      tr.dataset.vtKey = String(k);
      if (state.activeKey != null && k === state.activeKey) {
        tr.classList.add('active');
      }
      tbody.appendChild(tr);
    }
    tbody.appendChild(state.botPad);
    setPadHeights(first * state.rowHeight,
                  Math.max(0, (state.items.length - last)) * state.rowHeight);
    state.renderedRange = { start: first, end: last };
  }

  function applyActiveToRenderedRows() {
    // Only iterates ~35 rendered rows, not the full items array.
    for (const tr of tbody.children) {
      if (!tr.dataset || tr.classList.contains('vt-pad')) continue;
      const key = tr.dataset.vtKey;
      tr.classList.toggle('active', key !== undefined && key === String(state.activeKey));
    }
  }

  function scheduleRender() {
    if (state.rafPending) return;
    state.rafPending = true;
    requestAnimationFrame(render);
  }

  // Scroll handler — coalesced to one render per animation frame.
  viewport.addEventListener('scroll', scheduleRender, { passive: true });

  // Re-measure + re-render on resize. The viewport height affects how
  // many rows we render, and font-swap can change row height.
  const ro = new ResizeObserver(() => {
    if (state.items.length) measureRowHeight();
    state.renderedRange = { start: -1, end: -1 };   // force re-render
    scheduleRender();
  });
  ro.observe(viewport);

  // Re-measure + re-render once web fonts have settled. JetBrains Mono swap
  // changes row height by a pixel or two, which would otherwise leave the
  // pad-row math (and the scrollbar) subtly off until the next resize.
  if (typeof document !== 'undefined' && document.fonts?.ready) {
    document.fonts.ready.then(() => {
      if (!state.items.length) return;
      measureRowHeight();
      state.renderedRange = { start: -1, end: -1 };
      scheduleRender();
    });
  }

  return {
    setItems(items) {
      state.items = items || [];
      measureColumnCount();
      if (!state.topPad) buildPadRows();
      measureRowHeight();
      state.renderedRange = { start: -1, end: -1 };
      render();
    },
    setActive(key) {
      if (state.activeKey === key) return;
      state.activeKey = key;
      applyActiveToRenderedRows();
    },
    getActive()     { return state.activeKey; },
    scrollToKey(key) {
      const idx = state.items.findIndex((it) => keyFn(it) === key);
      if (idx < 0) return;
      const targetTop = idx * state.rowHeight;
      const vTop = viewport.scrollTop;
      const vBot = vTop + viewport.clientHeight;
      if (targetTop < vTop || targetTop + state.rowHeight > vBot) {
        viewport.scrollTop = Math.max(0, targetTop - viewport.clientHeight / 2);
      }
    },
    rerender()     { state.renderedRange = { start: -1, end: -1 }; render(); },
    rowHeight()    { return state.rowHeight; },
    itemCount()    { return state.items.length; },
  };
}
