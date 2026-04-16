import { describe, it, expect, vi } from 'vitest';
import { createLRU } from '../js/lru.js';

describe('createLRU', () => {
  it('evicts least-recently-touched key when over capacity', () => {
    const evicted = [];
    const lru = createLRU(3, (k) => evicted.push(k));
    lru.touch('a');
    lru.touch('b');
    lru.touch('c');
    lru.touch('d'); // → 'a' evicted
    expect(evicted).toEqual(['a']);
    expect(lru.has('a')).toBe(false);
    expect(lru.has('b')).toBe(true);
    expect(lru.size()).toBe(3);
  });

  it('promotes a key on re-touch so it avoids eviction', () => {
    const evicted = [];
    const lru = createLRU(3, (k) => evicted.push(k));
    lru.touch('a');
    lru.touch('b');
    lru.touch('c');
    lru.touch('a'); // a is now most-recent
    lru.touch('d'); // b should evict, not a
    expect(evicted).toEqual(['b']);
    expect(lru.has('a')).toBe(true);
  });

  it('never evicts pinned keys, even when stale', () => {
    const evicted = [];
    const lru = createLRU(2, (k) => evicted.push(k));
    lru.touch('pinned');
    lru.pin('pinned');
    lru.touch('x');
    lru.touch('y'); // without pin, 'pinned' would evict
    lru.touch('z');
    expect(lru.has('pinned')).toBe(true);
    expect(evicted).not.toContain('pinned');
  });

  it('remove() drops the key and its pin', () => {
    const lru = createLRU(2, () => {});
    lru.touch('k');
    lru.pin('k');
    lru.remove('k');
    expect(lru.has('k')).toBe(false);
    // re-touching works normally now
    lru.touch('k');
    lru.touch('a');
    lru.touch('b'); // should evict 'k' since it's no longer pinned
    expect(lru.has('k')).toBe(false);
  });

  it('clear() drops everything including pins', () => {
    const lru = createLRU(3, () => {});
    lru.touch('a');
    lru.pin('a');
    lru.touch('b');
    lru.clear();
    expect(lru.size()).toBe(0);
    expect(lru.has('a')).toBe(false);
  });

  it('swallows errors from the eviction callback without corrupting state', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const lru = createLRU(1, () => { throw new Error('boom'); });
    lru.touch('a');
    lru.touch('b');
    expect(lru.has('a')).toBe(false);
    expect(lru.has('b')).toBe(true);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
