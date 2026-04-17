/* opfs.test.js — unit tests for js/opfs.js.
 *
 * jsdom doesn't ship an OPFS implementation, so we wire up a minimal
 * Map-backed polyfill that mimics the directory-/file-handle protocol
 * we actually use (getDirectoryHandle, getFileHandle, createWritable,
 * getFile, name, code/NotFoundError). The polyfill is installed on
 * globalThis.navigator.storage before importing js/opfs.js so that
 * isOpfsAvailable() and getCorpusDir() walk the fake tree.
 */

import { describe, it, expect, beforeEach } from 'vitest';

/* ------------------------------------------------------------------ *
 * Fake OPFS: enough surface to satisfy js/opfs.js
 * ------------------------------------------------------------------ */
class FakeFile {
  constructor(bytes) {
    // Duck-typed normalization — instanceof checks are unreliable across
    // vitest/jsdom realms. A Uint8Array from the module under test shows
    // up here as ArrayBuffer.isView === true with a .buffer.
    if (ArrayBuffer.isView(bytes)) {
      this._bytes = new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    } else if (bytes && typeof bytes === 'object' && bytes instanceof ArrayBuffer) {
      this._bytes = new Uint8Array(bytes);
    } else if (bytes && bytes.constructor && bytes.constructor.name === 'ArrayBuffer') {
      this._bytes = new Uint8Array(bytes);
    } else {
      this._bytes = new TextEncoder().encode(String(bytes ?? ''));
    }
  }
  get size() { return this._bytes.byteLength; }
  async text() { return new TextDecoder().decode(this._bytes); }
  async arrayBuffer() {
    // Return a fresh ArrayBuffer copy.
    const out = new ArrayBuffer(this._bytes.byteLength);
    new Uint8Array(out).set(this._bytes);
    return out;
  }
}

class FakeWritable {
  constructor(onClose) { this._onClose = onClose; this._chunks = []; }
  async write(data) {
    if (data == null) return;
    if (typeof data === 'string') {
      this._chunks.push(new TextEncoder().encode(data));
    } else if (ArrayBuffer.isView(data)) {
      this._chunks.push(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
    } else if (data && data.constructor && data.constructor.name === 'ArrayBuffer') {
      this._chunks.push(new Uint8Array(data));
    } else if (data && typeof data.arrayBuffer === 'function') {
      const ab = await data.arrayBuffer();
      this._chunks.push(new Uint8Array(ab));
    } else {
      this._chunks.push(new TextEncoder().encode(String(data)));
    }
  }
  async close() {
    const total = this._chunks.reduce((n, c) => n + c.byteLength, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of this._chunks) { out.set(c, off); off += c.byteLength; }
    this._onClose(out);
  }
}

class FakeFileHandle {
  constructor(dir, name) { this._dir = dir; this._name = name; }
  get name() { return this._name; }
  async getFile() {
    const bytes = this._dir._files.get(this._name);
    if (!bytes) {
      const e = new Error(`NotFoundError: ${this._name}`);
      e.name = 'NotFoundError';
      throw e;
    }
    return new FakeFile(bytes);
  }
  async createWritable() {
    return new FakeWritable((bytes) => this._dir._files.set(this._name, bytes));
  }
}

class FakeDirHandle {
  constructor(name = '') {
    this._name = name;
    this._dirs = new Map();
    this._files = new Map();
  }
  get name() { return this._name; }
  async getDirectoryHandle(name, opts = {}) {
    if (!this._dirs.has(name)) {
      if (!opts.create) {
        const e = new Error(`NotFoundError: ${name}`);
        e.name = 'NotFoundError';
        throw e;
      }
      this._dirs.set(name, new FakeDirHandle(name));
    }
    return this._dirs.get(name);
  }
  async getFileHandle(name, opts = {}) {
    if (!this._files.has(name)) {
      if (!opts.create) {
        const e = new Error(`NotFoundError: ${name}`);
        e.name = 'NotFoundError';
        throw e;
      }
      this._files.set(name, new Uint8Array(0));
    }
    return new FakeFileHandle(this, name);
  }
}

function installFakeOpfs() {
  const root = new FakeDirHandle('');
  globalThis.navigator ??= {};
  globalThis.navigator.storage = {
    getDirectory: async () => root,
  };
  return root;
}

function uninstallOpfs() {
  if (globalThis.navigator) delete globalThis.navigator.storage;
}

/* ------------------------------------------------------------------ *
 * Tests
 * ------------------------------------------------------------------ */
describe('opfs helpers', () => {
  let opfs;
  let root;

  beforeEach(async () => {
    root = installFakeOpfs();
    // Fresh import each time so module-level caches (none today, but
    // cheap insurance) can't leak between tests.
    opfs = await import('../js/opfs.js');
  });

  it('isOpfsAvailable reflects navigator.storage.getDirectory', () => {
    expect(opfs.isOpfsAvailable()).toBe(true);
    uninstallOpfs();
    expect(opfs.isOpfsAvailable()).toBe(false);
    // Restore for subsequent tests — beforeEach would re-install but
    // leaving the state clean is cheap insurance.
    installFakeOpfs();
  });

  it('computeCacheKey sanitizes filename and encodes size/mtime', () => {
    const key = opfs.computeCacheKey({ name: 'weird name!@#.7z', size: 12345, lastModified: 67890 });
    expect(key).toBe('weird_name_.7z-12345-67890');
  });

  it('computeCacheKey tolerates missing size/mtime', () => {
    const key = opfs.computeCacheKey({ name: 'corpus.7z' });
    expect(key).toBe('corpus.7z-0-0');
  });

  it('getCorpusDir creates corpora/<key>/ under root', async () => {
    const dir = await opfs.getCorpusDir('k1');
    expect(dir.name).toBe('k1');
    // Walk the fake tree to verify placement.
    const corpora = root._dirs.get('corpora');
    expect(corpora).toBeTruthy();
    expect(corpora._dirs.get('k1')).toBe(dir);
  });

  it('writeFile + readFile round-trips bytes and creates intermediate dirs', async () => {
    const dir = await opfs.getCorpusDir('k2');
    await opfs.writeFile(dir, 'games/7.ndjson', new TextEncoder().encode('hello\nworld'));
    const f = await opfs.readFile(dir, 'games/7.ndjson');
    expect(f).toBeTruthy();
    expect(await f.text()).toBe('hello\nworld');
  });

  it('readFile returns null on missing entry (no throw)', async () => {
    const dir = await opfs.getCorpusDir('k3');
    const f = await opfs.readFile(dir, 'absent/file.bin');
    expect(f).toBeNull();
  });

  it('fileExists distinguishes present from absent', async () => {
    const dir = await opfs.getCorpusDir('k4');
    expect(await opfs.fileExists(dir, 'manifest.json')).toBe(false);
    await opfs.writeFile(dir, 'manifest.json', new TextEncoder().encode('{}'));
    expect(await opfs.fileExists(dir, 'manifest.json')).toBe(true);
  });

  it('appendText extends an existing file rather than overwriting', async () => {
    const dir = await opfs.getCorpusDir('k5');
    await opfs.appendText(dir, '.log', 'a\n');
    await opfs.appendText(dir, '.log', 'b\n');
    await opfs.appendText(dir, '.log', 'c\n');
    const f = await opfs.readFile(dir, '.log');
    expect(await f.text()).toBe('a\nb\nc\n');
  });

  it('appendFailed dedupes repeated game indices', async () => {
    const dir = await opfs.getCorpusDir('k6');
    await opfs.appendFailed(dir, 3);
    await opfs.appendFailed(dir, 7);
    await opfs.appendFailed(dir, 3); // duplicate
    await opfs.appendFailed(dir, 7); // duplicate
    await opfs.appendFailed(dir, 42);
    const failed = await opfs.readFailed(dir);
    expect([...failed].sort((a, b) => a - b)).toEqual([3, 7, 42]);
  });

  it('readFailed returns empty Set when .failed is missing', async () => {
    const dir = await opfs.getCorpusDir('k7');
    const failed = await opfs.readFailed(dir);
    expect(failed.size).toBe(0);
  });

  it('markComplete + isComplete round-trip', async () => {
    const dir = await opfs.getCorpusDir('k8');
    expect(await opfs.isComplete(dir)).toBe(false);
    await opfs.markComplete(dir);
    expect(await opfs.isComplete(dir)).toBe(true);
  });

  it('writeFile overwrites existing entries', async () => {
    const dir = await opfs.getCorpusDir('k9');
    await opfs.writeFile(dir, 'x.bin', new TextEncoder().encode('first'));
    await opfs.writeFile(dir, 'x.bin', new TextEncoder().encode('second'));
    const f = await opfs.readFile(dir, 'x.bin');
    expect(await f.text()).toBe('second');
  });

  it('separate cache keys are isolated', async () => {
    const a = await opfs.getCorpusDir('ka');
    const b = await opfs.getCorpusDir('kb');
    await opfs.writeFile(a, 'manifest.json', new TextEncoder().encode('A'));
    await opfs.writeFile(b, 'manifest.json', new TextEncoder().encode('B'));
    expect(await (await opfs.readFile(a, 'manifest.json')).text()).toBe('A');
    expect(await (await opfs.readFile(b, 'manifest.json')).text()).toBe('B');
  });
});
