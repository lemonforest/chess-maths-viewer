import { describe, it, expect, beforeEach } from 'vitest';
import { createVirtualTable } from '../js/virtual-table.js';

function buildTable(nCols = 3) {
  const viewport = document.createElement('div');
  viewport.style.height = '300px';
  viewport.style.overflowY = 'auto';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (let i = 0; i < nCols; i++) {
    const th = document.createElement('th');
    th.textContent = `col${i}`;
    headerRow.appendChild(th);
  }
  thead.appendChild(headerRow);
  const tbody = document.createElement('tbody');
  table.appendChild(thead);
  table.appendChild(tbody);
  viewport.appendChild(table);
  document.body.appendChild(viewport);
  return { viewport, table, tbody };
}

function renderRow(item) {
  const tr = document.createElement('tr');
  for (const v of [item.index, item.name, item.score]) {
    const td = document.createElement('td');
    td.textContent = String(v);
    tr.appendChild(td);
  }
  return tr;
}

describe('createVirtualTable', () => {
  beforeEach(() => { document.body.innerHTML = ''; });

  it('initializes with an empty dataset', () => {
    const { viewport, tbody } = buildTable();
    const vt = createVirtualTable({
      viewport, tbody, renderRow, keyFn: (it) => it.index,
    });
    vt.setItems([]);
    expect(vt.itemCount()).toBe(0);
    // Only pad rows (if any); no item rows
    const itemRows = [...tbody.children].filter((tr) => !tr.classList.contains('vt-pad'));
    expect(itemRows.length).toBe(0);
  });

  it('renders a window smaller than the full item list', () => {
    const { viewport, tbody } = buildTable();
    const items = Array.from({ length: 500 }, (_, i) =>
      ({ index: i, name: `row${i}`, score: i * 2 }));
    const vt = createVirtualTable({
      viewport, tbody, renderRow, keyFn: (it) => it.index, overscan: 2,
    });
    vt.setItems(items);
    expect(vt.itemCount()).toBe(500);
    const itemRows = [...tbody.children].filter((tr) => !tr.classList.contains('vt-pad'));
    // Far less than 500 (the point of virtualization)
    expect(itemRows.length).toBeLessThan(500);
    expect(itemRows.length).toBeGreaterThan(0);
    // Pad rows bracket the rendered window
    expect(tbody.firstElementChild.classList.contains('vt-pad-top')).toBe(true);
    expect(tbody.lastElementChild.classList.contains('vt-pad-bot')).toBe(true);
  });

  it('setActive toggles the .active class on the matching rendered row', () => {
    const { viewport, tbody } = buildTable();
    const items = Array.from({ length: 5 }, (_, i) =>
      ({ index: i, name: `row${i}`, score: 0 }));
    const vt = createVirtualTable({
      viewport, tbody, renderRow, keyFn: (it) => it.index,
    });
    vt.setItems(items);
    vt.setActive(2);
    const active = tbody.querySelector('tr.active');
    expect(active).not.toBeNull();
    expect(active.dataset.vtKey).toBe('2');
    vt.setActive(4);
    const stillActive = tbody.querySelectorAll('tr.active');
    expect(stillActive.length).toBe(1);
    expect(stillActive[0].dataset.vtKey).toBe('4');
  });

  it('scrollToKey is a no-op for an unknown key', () => {
    const { viewport, tbody } = buildTable();
    const items = [{ index: 0, name: 'a', score: 0 }];
    const vt = createVirtualTable({
      viewport, tbody, renderRow, keyFn: (it) => it.index,
    });
    vt.setItems(items);
    const before = viewport.scrollTop;
    vt.scrollToKey(999);
    expect(viewport.scrollTop).toBe(before);
  });

  it('rerender is idempotent after setItems', () => {
    const { viewport, tbody } = buildTable();
    const items = Array.from({ length: 20 }, (_, i) =>
      ({ index: i, name: `row${i}`, score: i }));
    const vt = createVirtualTable({
      viewport, tbody, renderRow, keyFn: (it) => it.index,
    });
    vt.setItems(items);
    const snapshot = tbody.innerHTML;
    vt.rerender();
    expect(tbody.innerHTML).toBe(snapshot);
  });
});
