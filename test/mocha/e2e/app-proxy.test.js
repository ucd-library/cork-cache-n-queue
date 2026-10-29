import assert from 'assert';
import { createApp } from '../../../src/app.js';
import { startServer } from './helpers.js';

const fakeLogger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} };

describe('e2e: proxy behavior', function () {
  this.timeout(10000);
  let origin, app, appServer;

  afterEach(async () => {
    if (appServer) await appServer.close();
    if (origin) await origin.close();
    appServer = null;
    origin = null;
  });

  it('round-trips a POST body and headers correctly with no queue/cache enabled', async () => {
    origin = await startServer(async (req, res) => {
      let chunks = [];
      for await (let chunk of req) chunks.push(chunk);
      let body = Buffer.concat(chunks).toString();
      res.writeHead(200, { 'content-type': 'text/plain', 'x-echo-method': req.method });
      res.end(`echo:${body}`);
    });

    app = createApp({ cache: null, queue: null, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let res = await fetch(`${appServer.url}/submit`, {
      method: 'POST',
      body: 'hello=world',
      headers: { 'content-type': 'application/x-www-form-urlencoded' }
    });

    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-echo-method'), 'POST');
    assert.strictEqual(await res.text(), 'echo:hello=world');
  });

  it('strips hop-by-hop headers from the proxied response', async () => {
    // Node's own http server always adds its own "connection" and
    // "keep-alive" response headers regardless of what upstream code does
    // (verified directly: a plain, untouched Node response already carries
    // both), so neither is a reliable signal of whether our stripping logic
    // ran. "proxy-authenticate" is hop-by-hop too, but Node never touches it
    // itself, so its absence here can only be explained by our own stripping.
    origin = await startServer((req, res) => {
      res.writeHead(200, { 'proxy-authenticate': 'Basic', 'x-keep-me': 'yes' });
      res.end('ok');
    });

    app = createApp({ cache: null, queue: null, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let res = await fetch(`${appServer.url}/anything`);
    assert.strictEqual(res.headers.get('x-keep-me'), 'yes');
    assert.strictEqual(res.headers.has('proxy-authenticate'), false);
  });

  it('preserves multiple Set-Cookie headers as separate values', async () => {
    origin = await startServer((req, res) => {
      res.writeHead(200, { 'set-cookie': ['a=1', 'b=2'] });
      res.end('ok');
    });

    app = createApp({ cache: null, queue: null, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let res = await fetch(`${appServer.url}/anything`);
    let cookies = typeof res.headers.getSetCookie === 'function'
      ? res.headers.getSetCookie()
      : [res.headers.get('set-cookie')];
    assert.deepStrictEqual([...cookies].sort(), ['a=1', 'b=2']);
  });

  it('responds 502 when the upstream origin is unreachable', async () => {
    // start a server to claim an ephemeral port, then close it immediately -
    // nothing is listening there afterward, giving a reliable ECONNREFUSED
    // target without depending on any specific "known closed" port number
    let probe = await startServer((req, res) => res.end());
    let deadPort = new URL(probe.url).port;
    await probe.close();

    app = createApp({ cache: null, queue: null, upstreamUrl: `http://127.0.0.1:${deadPort}`, logger: fakeLogger });
    appServer = await startServer(app);

    let res = await fetch(`${appServer.url}/anything`);
    assert.strictEqual(res.status, 502);
  });

  it('completes cleanly for a bodyless upstream response (e.g. 204 No Content)', async () => {
    origin = await startServer((req, res) => {
      res.writeHead(204, { 'x-no-body': 'yes' });
      res.end();
    });

    app = createApp({ cache: null, queue: null, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let res = await fetch(`${appServer.url}/anything`);
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get('x-no-body'), 'yes');
    assert.strictEqual(await res.text(), '');
  });

  it('aborts the upstream fetch when the client disconnects mid-response', async function () {
    this.timeout(5000);
    let originAborted = false;

    origin = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.write('partial-');
      res.on('close', () => { originAborted = true; });
      // deliberately never calls res.end() - this request only ever
      // completes if the connection is aborted
    });

    app = createApp({ cache: null, queue: null, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let controller = new AbortController();
    let fetchPromise = fetch(`${appServer.url}/stream`, { signal: controller.signal }).catch(() => null);

    await new Promise(resolve => setTimeout(resolve, 150));
    controller.abort();
    await fetchPromise;

    await new Promise(resolve => setTimeout(resolve, 300));
    assert.strictEqual(originAborted, true, 'expected the upstream connection to be aborted once the client disconnected');
  });
});
