/* Test harness setup: polyfill browser APIs jsdom doesn't ship. */

if (typeof globalThis.ResizeObserver === 'undefined') {
  globalThis.ResizeObserver = class {
    observe()   {}
    unobserve() {}
    disconnect() {}
  };
}
