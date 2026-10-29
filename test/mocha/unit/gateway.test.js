import assert from 'assert';
import { createGatewayHandler } from '../../../src/controllers/gateway.js';

const loggedErrors = [];
const fakeLogger = {
  info() {}, warn() {}, debug() {}, trace() {}, fatal() {},
  error(...args) { loggedErrors.push(args); }
};

function fakeReq({ path = '/anything', method = 'GET' } = {}) {
  return { path, method, headers: {}, originalUrl: path, socket: { remoteAddress: '203.0.113.1' } };
}

function fakeRes() {
  let res = {};
  res.statusCode = null;
  res.headersSent = false;
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.send = (body) => { res.body = body; res.headersSent = true; return res; };
  res.setHeader = () => res;
  return res;
}

describe('gateway handler', () => {

  beforeEach(() => {
    loggedErrors.length = 0;
  });

  it('responds 502 and logs when an unexpected error is thrown inside the pipeline', async () => {
    let cache = { isInScope() { throw new Error('boom'); } };
    let handler = createGatewayHandler({ cache, queue: null, upstreamUrl: 'http://localhost:1', logger: fakeLogger });

    let res = fakeRes();
    await handler(fakeReq(), res);

    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.body, 'Bad Gateway');
    assert.strictEqual(loggedErrors.length, 1);
    assert.strictEqual(loggedErrors[0][0], 'gateway: unhandled error');
  });

  it('does not attempt to send a second response if headers were already sent before the error', async () => {
    let cache = {
      isInScope: () => true,
      deriveKey: () => 'key',
      getOrWait: async () => null,
      beginWrite: () => null
    };
    let queue = {
      admit: async (req, res) => {
        // simulate a response already having been partially sent, then an
        // unexpected error occurring afterward
        res.status(200).send('partial');
        throw new Error('boom after headers sent');
      }
    };
    let handler = createGatewayHandler({ cache, queue, upstreamUrl: 'http://localhost:1', logger: fakeLogger });

    let res = fakeRes();
    await handler(fakeReq(), res);

    assert.strictEqual(res.statusCode, 200, 'the original response must not be overwritten');
    assert.strictEqual(res.body, 'partial');
    assert.strictEqual(loggedErrors.length, 1, 'the error should still be logged even though no second response is sent');
  });

  it('propagates a rejected promise from queue.admit() the same way as a thrown error', async () => {
    let queue = { admit: async () => { throw new Error('postgres pool exhausted unexpectedly'); } };
    let handler = createGatewayHandler({ cache: null, queue, upstreamUrl: 'http://localhost:1', logger: fakeLogger });

    let res = fakeRes();
    await handler(fakeReq(), res);

    assert.strictEqual(res.statusCode, 502);
  });
});
