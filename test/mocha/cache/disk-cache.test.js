import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { DiskCache } from '../../../src/lib/cache/index.js';

const ALWAYS_IN_SCOPE_RULES = [[{ target: 'path', matchType: 'startsWith', value: '/' }]];

const fakeLogger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} };

function makeCache(overrides = {}) {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnq-cache-'));
  let config = {
    dir,
    maxSizeBytes: 1024 * 1024,
    maxItemSizeBytes: 1024 * 1024,
    ttlMs: 60000,
    respectCacheControl: true,
    methods: ['GET'],
    varyHeaders: [],
    keyIncludeQuery: true,
    sweepIntervalMs: 60000,
    ...overrides
  };
  return new DiskCache({ config, rules: ALWAYS_IN_SCOPE_RULES, logger: fakeLogger });
}

function fakeReq({ method = 'GET', path = '/foo' } = {}) {
  return { method, path, originalUrl: path, headers: {} };
}

async function populate(cache, key, { status = 200, headers = {}, body = 'hello' } = {}) {
  let sink = cache.beginWrite(key);
  sink.write(Buffer.from(body));
  await sink.finish(status, headers);
}

describe('DiskCache', () => {

  afterEach(function () {
    // nothing persistent to clean up across processes; tmp dirs are unique per test
  });

  it('isInScope respects the method filter and the ruleset', () => {
    let cache = makeCache({ methods: ['GET'] });
    assert.strictEqual(cache.isInScope(fakeReq({ method: 'GET' })), true);
    assert.strictEqual(cache.isInScope(fakeReq({ method: 'POST' })), false);
  });

  it('roundtrips a basic hit: status, headers, and body all preserved', async () => {
    let cache = makeCache();
    let key = 'roundtrip-key';
    await populate(cache, key, { status: 201, headers: { 'content-type': 'text/plain' }, body: 'hello world' });

    let hit = await cache.getOrWait(key);
    assert.ok(hit, 'expected a cache hit');
    assert.strictEqual(hit.status, 201);
    assert.strictEqual(hit.headers['content-type'], 'text/plain');
    assert.strictEqual(fs.readFileSync(hit.bodyPath, 'utf8'), 'hello world');
  });

  it('misses on an unknown key', async () => {
    let cache = makeCache();
    let hit = await cache.getOrWait('never-written');
    assert.strictEqual(hit, null);
  });

  it('expires an entry past its TTL', async () => {
    let cache = makeCache({ ttlMs: 10 });
    let key = 'ttl-key';
    await populate(cache, key);

    assert.ok(await cache.getOrWait(key), 'expected an immediate hit');
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.strictEqual(await cache.getOrWait(key), null, 'expected a miss after ttl expiry');
  });

  it('honors max-age from Cache-Control as the ttl', async () => {
    let cache = makeCache({ ttlMs: 60000 });
    let key = 'cc-maxage';
    await populate(cache, key, { headers: { 'cache-control': 'max-age=0' } });
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.strictEqual(await cache.getOrWait(key), null, 'max-age=0 should expire almost immediately');
  });

  it('never caches a response with no-store', async () => {
    let cache = makeCache();
    let key = 'no-store';
    await populate(cache, key, { headers: { 'cache-control': 'no-store' } });
    assert.strictEqual(await cache.getOrWait(key), null);
  });

  it('never caches a response with private', async () => {
    let cache = makeCache();
    let key = 'private';
    await populate(cache, key, { headers: { 'cache-control': 'private' } });
    assert.strictEqual(await cache.getOrWait(key), null);
  });

  it('never caches a response with no-cache', async () => {
    let cache = makeCache();
    let key = 'no-cache';
    await populate(cache, key, { headers: { 'cache-control': 'no-cache' } });
    assert.strictEqual(await cache.getOrWait(key), null);
  });

  it('never caches a response carrying Set-Cookie, regardless of respectCacheControl', async () => {
    let cache = makeCache({ respectCacheControl: false });
    let key = 'set-cookie';
    await populate(cache, key, { headers: { 'set-cookie': 'a=1' } });
    assert.strictEqual(await cache.getOrWait(key), null);
  });

  it('uses the fallback ttl when respectCacheControl is false', async () => {
    let cache = makeCache({ respectCacheControl: false, ttlMs: 60000 });
    let key = 'ignore-cc';
    await populate(cache, key, { headers: { 'cache-control': 'no-store' } });
    assert.ok(await cache.getOrWait(key), 'expected a hit since respectCacheControl is disabled');
  });

  it('aborts an oversized write without affecting other entries', async () => {
    let cache = makeCache({ maxItemSizeBytes: 10 });
    let key = 'too-big';

    let sink = cache.beginWrite(key);
    sink.write(Buffer.from('this is way more than ten bytes'));
    await sink.finish(200, {});

    assert.strictEqual(await cache.getOrWait(key), null, 'oversized entry should not be cached');
  });

  it('evicts least-recently-used entries once over the size budget', async () => {
    let cache = makeCache({ maxSizeBytes: 15 });
    let tick = () => new Promise(resolve => setTimeout(resolve, 5));

    await populate(cache, 'a', { body: '12345' }); // 5 bytes
    await tick();
    await populate(cache, 'b', { body: '12345' }); // 5 bytes, total 10
    await tick();
    await cache.getOrWait('a'); // touch "a" so it's the most recently used
    await tick();
    await populate(cache, 'c', { body: '1234567890' }); // 10 bytes, total would be 20, over budget by 5

    // "b" is now the least-recently-used and should have been evicted
    assert.strictEqual(await cache.getOrWait('b'), null, 'expected "b" to be evicted as least-recently-used');
    assert.ok(await cache.getOrWait('a'), 'expected "a" to survive since it was touched more recently');
    assert.ok(await cache.getOrWait('c'), 'expected the newest entry "c" to be present');
  });

  it('sweep() evicts expired entries that were never re-looked-up', async () => {
    let cache = makeCache({ ttlMs: 10 });
    await populate(cache, 'sweep-me');
    await new Promise(resolve => setTimeout(resolve, 30));

    assert.strictEqual(cache.index.map.has('sweep-me'), true, 'entry should still be in the index pre-sweep');
    cache.index.sweep();
    assert.strictEqual(cache.index.map.has('sweep-me'), false, 'sweep should have evicted the expired entry');
  });

  it('deduplicates concurrent misses for the same key (thundering-herd)', async () => {
    let cache = makeCache();
    let key = 'herd-key';

    let leaderSink = cache.beginWrite(key);
    assert.ok(leaderSink, 'expected to claim leadership');

    let followerResult = cache.getOrWait(key); // should wait, not return null immediately as a plain miss would after this point

    // a second concurrent attempt to become leader must fail while the first is in flight
    assert.strictEqual(cache.beginWrite(key), null, 'a second leader should not be able to claim the same key');

    leaderSink.write(Buffer.from('herd body'));
    await leaderSink.finish(200, {});

    let hit = await followerResult;
    assert.ok(hit, 'follower should see the leader\'s result once it settles');
    assert.strictEqual(fs.readFileSync(hit.bodyPath, 'utf8'), 'herd body');
  });

  it('unblocks waiting followers even when the leader write is not cacheable', async () => {
    let cache = makeCache();
    let key = 'herd-fail-key';

    let leaderSink = cache.beginWrite(key);
    let followerResult = cache.getOrWait(key);

    leaderSink.write(Buffer.from('nope'));
    await leaderSink.finish(200, { 'cache-control': 'no-store' });

    let hit = await followerResult;
    assert.strictEqual(hit, null, 'follower should see a miss since the leader\'s response was not cacheable');

    // the key should be claimable again now that the leader has released it
    assert.ok(cache.beginWrite(key), 'expected to be able to claim the key again after release');
  });
});
