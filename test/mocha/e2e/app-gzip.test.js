import assert from 'assert';
import zlib from 'zlib';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createApp } from '../../../src/app.js';
import { DiskCache } from '../../../src/lib/cache/index.js';
import { startServer, rawGet } from './helpers.js';

const fakeLogger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} };
const GZIP_MAGIC = Buffer.from([0x1f, 0x8b]);
const PLAIN_BODY = '<html><body>hello from origin</body></html>';

describe('e2e: gzip-encoded upstream responses', function () {
  this.timeout(10000);
  let origin, app, appServer;

  afterEach(async () => {
    if (appServer) await appServer.close();
    if (origin) await origin.close();
    appServer = null;
    origin = null;
  });

  async function startGzipOrigin(extraHeaders = {}) {
    return startServer((req, res) => {
      let compressed = zlib.gzipSync(PLAIN_BODY);
      res.writeHead(200, { 'content-type': 'text/html', 'content-encoding': 'gzip', ...extraHeaders });
      res.end(compressed);
    });
  }

  it('never pairs a content-encoding header with a body that does not actually carry that encoding (no cache)', async () => {
    origin = await startGzipOrigin();
    app = createApp({ cache: null, queue: null, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    // a client that asks for gzip should get a response whose raw bytes are genuinely gzip
    let gzipClient = await rawGet(`${appServer.url}/page`, { headers: { 'accept-encoding': 'gzip' } });
    assert.strictEqual(gzipClient.headers['content-encoding'], 'gzip');
    assert.strictEqual(gzipClient.body.subarray(0, 2).equals(GZIP_MAGIC), true, 'content-encoding: gzip was set but the body is not actually gzip');
    assert.strictEqual(zlib.gunzipSync(gzipClient.body).toString(), PLAIN_BODY);

    // a client that never asked for any encoding (e.g. plain curl) must not
    // receive a content-encoding header paired with un-decodable bytes -
    // this is the exact bug reported: curl showed content-encoding: gzip
    // over a body that was never actually gzipped
    let plainClient = await rawGet(`${appServer.url}/page`);
    assert.strictEqual(plainClient.headers['content-encoding'], undefined);
    assert.strictEqual(plainClient.body.toString(), PLAIN_BODY);

    // and a real fetch(), which auto-decodes transparently, must still see correct text
    let res = await fetch(`${appServer.url}/page`);
    assert.strictEqual(await res.text(), PLAIN_BODY);
  });

  it('stays internally consistent across a cache MISS and the subsequent HIT', async () => {
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnq-e2e-gzip-cache-'));
    let cache = new DiskCache({
      config: {
        dir, maxSizeBytes: 1024 * 1024, maxItemSizeBytes: 1024 * 1024, ttlMs: 60000,
        respectCacheControl: false, methods: ['GET', 'HEAD'], varyHeaders: [], keyIncludeQuery: true,
        sweepIntervalMs: 60000
      },
      rules: [[{ target: 'path', matchType: 'startsWith', value: '/' }]],
      logger: fakeLogger
    });

    origin = await startGzipOrigin();
    app = createApp({ cache, queue: null, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let miss = await rawGet(`${appServer.url}/page`, { headers: { 'accept-encoding': 'gzip' } });
    assert.strictEqual(miss.headers['x-cache'], 'MISS');
    assert.strictEqual(miss.headers['content-encoding'], 'gzip');
    assert.strictEqual(zlib.gunzipSync(miss.body).toString(), PLAIN_BODY);

    let hit = await rawGet(`${appServer.url}/page`, { headers: { 'accept-encoding': 'gzip' } });
    assert.strictEqual(hit.headers['x-cache'], 'HIT');
    assert.strictEqual(hit.headers['content-encoding'], 'gzip');
    assert.strictEqual(zlib.gunzipSync(hit.body).toString(), PLAIN_BODY);
  });
});
