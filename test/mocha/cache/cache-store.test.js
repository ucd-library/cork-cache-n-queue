import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CacheStore } from '../../../src/lib/cache/store.js';

function makeStore() {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnq-cache-store-'));
  return new CacheStore({ dir });
}

describe('CacheStore', () => {

  it('readEntry returns null for a key that was never written', () => {
    let store = makeStore();
    assert.strictEqual(store.readEntry('never-written'), null);
  });

  it('readEntry returns null (not a throw) for a corrupted meta file', () => {
    let store = makeStore();
    let p = store._paths('corrupt-key');
    fs.mkdirSync(p.shardDir, { recursive: true });
    fs.writeFileSync(p.metaPath, 'this is not valid json {{{');

    assert.doesNotThrow(() => {
      assert.strictEqual(store.readEntry('corrupt-key'), null);
    });
  });

  it('deleteEntry is a safe no-op when nothing exists for the key', () => {
    let store = makeStore();
    assert.doesNotThrow(() => store.deleteEntry('nothing-here'));
  });

  it('writes and reads back a full entry via the write sink', async () => {
    let store = makeStore();
    let key = 'roundtrip';

    let sink = store.createWriteSink(key);
    sink.write(Buffer.from('hello '));
    sink.write(Buffer.from('world'));
    let { size } = await sink.finish({ status: 201, headers: { 'content-type': 'text/plain' }, createdAt: 1, expiresAt: 2 });

    assert.strictEqual(size, 'hello world'.length);

    let entry = store.readEntry(key);
    assert.strictEqual(entry.status, 201);
    assert.strictEqual(entry.headers['content-type'], 'text/plain');
    assert.strictEqual(entry.size, size);
    assert.strictEqual(fs.readFileSync(entry.bodyPath, 'utf8'), 'hello world');
  });

  it('abort() discards everything written, leaving no tmp files behind', async () => {
    let store = makeStore();
    let key = 'aborted';

    let sink = store.createWriteSink(key);
    sink.write(Buffer.from('partial data'));
    sink.abort();

    assert.strictEqual(store.readEntry(key), null);

    let p = store._paths(key);
    let remaining = fs.readdirSync(p.shardDir);
    assert.strictEqual(remaining.length, 0, `expected no leftover files in the shard dir, found: ${remaining.join(', ')}`);
  });

  it('finish() rejects if the sink was already aborted', async () => {
    let store = makeStore();
    let sink = store.createWriteSink('double-settle');
    sink.abort();
    await assert.rejects(sink.finish({ status: 200, headers: {} }));
  });

  it('deleteEntry removes a previously written entry', async () => {
    let store = makeStore();
    let key = 'to-delete';
    let sink = store.createWriteSink(key);
    sink.write(Buffer.from('x'));
    await sink.finish({ status: 200, headers: {} });

    assert.ok(store.readEntry(key));
    store.deleteEntry(key);
    assert.strictEqual(store.readEntry(key), null);
  });
});
