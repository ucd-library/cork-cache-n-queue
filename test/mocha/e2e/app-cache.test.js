import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp } from '../../../src/app.js';
import { DiskCache } from '../../../src/lib/cache/index.js';
import { startServer } from './helpers.js';

const fakeLogger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} };
const CACHE_RULES = [[{ target: 'path', matchType: 'startsWith', value: '/' }]];

function makeCache(overrides = {}) {
  let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnq-e2e-cache-'));
  return new DiskCache({
    config: {
      dir, maxSizeBytes: 1024 * 1024, maxItemSizeBytes: 1024 * 1024, ttlMs: 60000,
      respectCacheControl: true, methods: ['GET', 'HEAD'], varyHeaders: [], keyIncludeQuery: true,
      sweepIntervalMs: 60000, ...overrides
    },
    rules: CACHE_RULES,
    logger: fakeLogger
  });
}

describe('e2e: cache gate', function () {
  this.timeout(10000);
  let origin, app, appServer;

  afterEach(async () => {
    if (appServer) await appServer.close();
    if (origin) await origin.close();
    appServer = null;
    origin = null;
  });

  it('a cache hit bypasses the origin entirely', async () => {
    let requestCount = 0;
    origin = await startServer((req, res) => {
      requestCount++;
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'max-age=60' });
      res.end('hello from origin');
    });

    let cache = makeCache();
    app = createApp({ cache, queue: null, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let r1 = await fetch(`${appServer.url}/static/file.txt`);
    assert.strictEqual(await r1.text(), 'hello from origin');
    assert.strictEqual(requestCount, 1);

    let r2 = await fetch(`${appServer.url}/static/file.txt`);
    assert.strictEqual(await r2.text(), 'hello from origin');
    assert.strictEqual(requestCount, 1, 'second request should be served from cache without hitting the origin');
  });

  it('tags a miss X-Cache: MISS and a subsequent hit X-Cache: HIT', async () => {
    origin = await startServer((req, res) => {
      res.writeHead(200, { 'cache-control': 'max-age=60' });
      res.end('hello');
    });

    let cache = makeCache();
    app = createApp({ cache, queue: null, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let r1 = await fetch(`${appServer.url}/static/tagged.txt`);
    assert.strictEqual(r1.headers.get('x-cache'), 'MISS');

    let r2 = await fetch(`${appServer.url}/static/tagged.txt`);
    assert.strictEqual(r2.headers.get('x-cache'), 'HIT');
  });

  it('tags a request outside the cache ruleset/methods X-Cache: BYPASS', async () => {
    origin = await startServer((req, res) => {
      res.writeHead(200, { 'cache-control': 'max-age=60' });
      res.end('hello');
    });

    let cache = makeCache({ methods: ['GET'] });
    app = createApp({ cache, queue: null, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let res = await fetch(`${appServer.url}/static/a.txt`, { method: 'POST' });
    assert.strictEqual(res.headers.get('x-cache'), 'BYPASS');
  });

  it('a non-cacheable response (no-store) is never served from cache', async () => {
    let requestCount = 0;
    origin = await startServer((req, res) => {
      requestCount++;
      res.writeHead(200, { 'cache-control': 'no-store' });
      res.end('fresh-' + requestCount);
    });

    let cache = makeCache();
    app = createApp({ cache, queue: null, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let r1 = await fetch(`${appServer.url}/static/a.txt`);
    assert.strictEqual(await r1.text(), 'fresh-1');

    let r2 = await fetch(`${appServer.url}/static/a.txt`);
    assert.strictEqual(await r2.text(), 'fresh-2');
    assert.strictEqual(requestCount, 2);
  });

  it('a request outside the cache ruleset is never cached', async () => {
    let requestCount = 0;
    origin = await startServer((req, res) => {
      requestCount++;
      res.writeHead(200, { 'cache-control': 'max-age=60' });
      res.end('hit-' + requestCount);
    });

    let cache = makeCache({ methods: ['GET'] });
    app = createApp({ cache, queue: null, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let r1 = await fetch(`${appServer.url}/static/a.txt`, { method: 'POST' });
    assert.strictEqual(await r1.text(), 'hit-1');

    let r2 = await fetch(`${appServer.url}/static/a.txt`, { method: 'POST' });
    assert.strictEqual(await r2.text(), 'hit-2');
    assert.strictEqual(requestCount, 2, 'POST is not in the cache methods list, so it should never be cached');
  });

  it('a bodyless upstream response (204) is never cached', async () => {
    let requestCount = 0;
    origin = await startServer((req, res) => {
      requestCount++;
      res.writeHead(204, { 'cache-control': 'max-age=60' });
      res.end();
    });

    let cache = makeCache();
    app = createApp({ cache, queue: null, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let r1 = await fetch(`${appServer.url}/static/empty.txt`);
    assert.strictEqual(r1.status, 204);

    let r2 = await fetch(`${appServer.url}/static/empty.txt`);
    assert.strictEqual(r2.status, 204);
    assert.strictEqual(requestCount, 2, 'a 204 has no body to cache, so the origin must be hit again');
  });

  it('two concurrent requests for the same not-yet-cached url only hit the origin once (thundering-herd dedup)', async () => {
    let requestCount = 0;
    let release;
    let gate = new Promise(resolve => { release = resolve; });

    origin = await startServer(async (req, res) => {
      requestCount++;
      await gate; // hold every request open until we release, to force genuine overlap
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'max-age=60' });
      res.end('shared body');
    });

    let cache = makeCache();
    app = createApp({ cache, queue: null, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let p1 = fetch(`${appServer.url}/static/herd.txt`);
    let p2 = fetch(`${appServer.url}/static/herd.txt`);

    // give both requests a moment to reach the (blocked) origin before releasing
    await new Promise(resolve => setTimeout(resolve, 100));
    release();

    let [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(await r1.text(), 'shared body');
    assert.strictEqual(await r2.text(), 'shared body');
    assert.strictEqual(requestCount, 1, 'the second concurrent request should wait on the first instead of also hitting the origin');
  });
});
