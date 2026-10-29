import assert from 'assert';
import { MemoryIndex } from '../../../src/lib/cache/memory-index.js';

function tick(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

describe('MemoryIndex', () => {

  it('get() returns null for a missing key', () => {
    let index = new MemoryIndex({ maxSizeBytes: 1000 });
    assert.strictEqual(index.get('missing'), null);
  });

  it('set() then get() returns the entry and tracks total size', () => {
    let index = new MemoryIndex({ maxSizeBytes: 1000 });
    index.set({ key: 'a', sizeBytes: 10, expiresAt: Date.now() + 10000 });

    let entry = index.get('a');
    assert.strictEqual(entry.key, 'a');
    assert.strictEqual(entry.sizeBytes, 10);
    assert.strictEqual(index.totalSizeBytes, 10);
  });

  it('get() on an expired entry returns null, removes it, and fires onEvict', () => {
    let evicted = [];
    let index = new MemoryIndex({ maxSizeBytes: 1000, onEvict: key => evicted.push(key) });
    index.set({ key: 'a', sizeBytes: 10, expiresAt: Date.now() - 1 });

    assert.strictEqual(index.get('a'), null);
    assert.deepStrictEqual(evicted, ['a']);
    assert.strictEqual(index.totalSizeBytes, 0);
  });

  it('set() replacing an existing key does not double-count its size', () => {
    let index = new MemoryIndex({ maxSizeBytes: 1000 });
    index.set({ key: 'a', sizeBytes: 10, expiresAt: Date.now() + 10000 });
    index.set({ key: 'a', sizeBytes: 25, expiresAt: Date.now() + 10000 });
    assert.strictEqual(index.totalSizeBytes, 25);
  });

  it('delete() removes an entry, updates total size, and fires onEvict', () => {
    let evicted = [];
    let index = new MemoryIndex({ maxSizeBytes: 1000, onEvict: key => evicted.push(key) });
    index.set({ key: 'a', sizeBytes: 10, expiresAt: Date.now() + 10000 });

    index.delete('a');
    assert.strictEqual(index.get('a'), null);
    assert.strictEqual(index.totalSizeBytes, 0);
    assert.deepStrictEqual(evicted, ['a']);
  });

  it('delete() on a missing key is a safe no-op', () => {
    let evicted = [];
    let index = new MemoryIndex({ maxSizeBytes: 1000, onEvict: key => evicted.push(key) });
    index.delete('missing');
    assert.deepStrictEqual(evicted, []);
  });

  it('evicts least-recently-used entries synchronously on set() once over budget', async () => {
    let evicted = [];
    let index = new MemoryIndex({ maxSizeBytes: 15, onEvict: key => evicted.push(key) });

    index.set({ key: 'a', sizeBytes: 5, expiresAt: Date.now() + 10000 });
    await tick(5);
    index.set({ key: 'b', sizeBytes: 5, expiresAt: Date.now() + 10000 });
    await tick(5);
    index.get('a'); // touch "a" so "b" becomes the least-recently-used
    await tick(5);
    index.set({ key: 'c', sizeBytes: 10, expiresAt: Date.now() + 10000 }); // total would be 20, over budget by 5

    assert.deepStrictEqual(evicted, ['b']);
    assert.ok(index.get('a'));
    assert.ok(index.get('c'));
    assert.strictEqual(index.get('b'), null);
  });

  it('sweep() evicts expired entries regardless of whether they were re-looked-up', () => {
    let index = new MemoryIndex({ maxSizeBytes: 1000 });
    index.set({ key: 'a', sizeBytes: 5, expiresAt: Date.now() - 1 });
    index.set({ key: 'b', sizeBytes: 5, expiresAt: Date.now() + 10000 });

    // bypass get()'s own lazy-expiry check entirely by calling sweep() directly
    index.sweep();

    assert.strictEqual(index.map.has('a'), false);
    assert.strictEqual(index.map.has('b'), true);
  });

  it('sweep() also re-verifies the size budget', () => {
    let evicted = [];
    let index = new MemoryIndex({ maxSizeBytes: 10, onEvict: key => evicted.push(key) });
    // insert directly into the map to simulate a budget violation that
    // wasn't caught by set()'s own synchronous check
    index.map.set('a', { key: 'a', sizeBytes: 20, expiresAt: Date.now() + 10000, lastAccessedAt: Date.now() });
    index.totalSizeBytes = 20;

    index.sweep();
    assert.deepStrictEqual(evicted, ['a']);
  });
});
