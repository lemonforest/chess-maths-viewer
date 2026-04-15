/* lru.js — tiny Map-backed LRU with eviction callback and pinning.
 *
 * Used by the corpus loader to cap how many games' parsed state
 * (game.spectral, game.plies) we keep in memory at once. Eviction
 * is what lets the viewer browse a 15k-game corpus without
 * unbounded heap growth.
 *
 * Ordering is provided by Map's insertion order: touch(key) re-inserts
 * the key so the least-recently-touched key is at the iterator head.
 * Pinned keys never evict (used to keep the currently-active game alive
 * even if many other games have been touched since).
 */

export function createLRU(capacity, onEvict) {
  const order = new Map();    // key → true (insertion order = recency)
  const pinned = new Set();

  function evictIfNeeded() {
    if (order.size <= capacity) return;
    for (const k of order.keys()) {
      if (pinned.has(k)) continue;
      order.delete(k);
      try { onEvict(k); } catch (e) { console.error('lru onEvict:', e); }
      if (order.size <= capacity) return;
    }
  }

  return {
    touch(key) {
      if (order.has(key)) order.delete(key);
      order.set(key, true);
      evictIfNeeded();
    },
    has(key)    { return order.has(key); },
    remove(key) { order.delete(key); pinned.delete(key); },
    pin(key)    { pinned.add(key); },
    unpin(key)  { pinned.delete(key); },
    size()      { return order.size; },
    capacity()  { return capacity; },
    clear()     { order.clear(); pinned.clear(); },
  };
}
