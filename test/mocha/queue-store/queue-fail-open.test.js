import assert from 'assert';
import { EventEmitter } from 'events';
import { Queue } from '../../../src/lib/queue/index.js';
import { createAllowlist } from '../../../src/lib/queue/allowlist.js';

// Pure unit tests against a fake store - no Postgres/Docker needed. These
// exist specifically to verify the documented "fail-open" guarantee: a
// Postgres error should let the request through rather than blocking
// traffic, except for the one deliberate exception (reconcileStale failing
// while the queue is already full still rejects, since that path's own
// logic - not the error - is what decides the outcome).

const ALWAYS_IN_SCOPE_RULES = [[{ target: 'path', matchType: 'startsWith', value: '/' }]];
const loggedErrors = [];
const fakeLogger = {
  info() {}, warn() {}, debug() {}, trace() {}, fatal() {},
  error(...args) { loggedErrors.push(args); }
};

function fakeReq() {
  let req = new EventEmitter();
  req.method = 'GET';
  req.path = '/binary/file.pdf';
  req.headers = {};
  req.socket = { remoteAddress: '203.0.113.1' };
  return req;
}

function fakeRes() {
  let res = new EventEmitter();
  res.statusCode = null;
  res.headers = {};
  res.body = null;
  res.status = (code) => { res.statusCode = code; return res; };
  res.set = (name, value) => { res.headers[name] = value; return res; };
  res.send = (body) => { res.body = body; return res; };
  return res;
}

function notCalled(name) {
  return async () => { throw new Error(`${name} should not have been called on this code path`); };
}

function buildQueue(store, overrides = {}) {
  return new Queue({
    config: {
      methods: [], maxServedPerGroup: 1, maxPendingPerGroup: 1, pendingTimeoutMs: 100, pollIntervalMs: 20,
      ipv4PrefixLength: 24, ipv6PrefixLength: 64, staleActiveMs: 300000, clientIpHeader: '',
      ...overrides
    },
    store,
    allowlist: createAllowlist(''),
    rules: ALWAYS_IN_SCOPE_RULES,
    logger: fakeLogger
  });
}

describe('Queue fail-open behavior (fake store, no Postgres)', () => {

  beforeEach(() => {
    loggedErrors.length = 0;
  });

  it('fails open when tryAdmit rejects', async () => {
    let store = {
      tryAdmit: async () => { throw new Error('connection refused'); },
      enqueueIfRoom: notCalled('enqueueIfRoom'),
      reconcileStale: notCalled('reconcileStale'),
      isActive: notCalled('isActive'),
      expirePending: notCalled('expirePending'),
      releaseAndPromote: notCalled('releaseAndPromote')
    };
    let queue = buildQueue(store);

    let result = await queue.admit(fakeReq(), fakeRes());
    assert.strictEqual(result, true, 'a tryAdmit error must fail open');
    assert.strictEqual(loggedErrors.length, 1);
  });

  it('fails open when enqueueIfRoom rejects', async () => {
    let store = {
      tryAdmit: async () => false, // slot taken, must proceed to enqueueIfRoom
      enqueueIfRoom: async () => { throw new Error('connection refused'); },
      reconcileStale: notCalled('reconcileStale'),
      isActive: notCalled('isActive'),
      expirePending: notCalled('expirePending'),
      releaseAndPromote: notCalled('releaseAndPromote')
    };
    let queue = buildQueue(store);

    let result = await queue.admit(fakeReq(), fakeRes());
    assert.strictEqual(result, true, 'an enqueueIfRoom error must fail open');
  });

  it('does NOT fail open when reconcileStale rejects while the queue is already full', async () => {
    // this is the one deliberate exception: reconcileStale only runs as a
    // best-effort crash-recovery sweep once the current caller is already
    // being rejected, so a failure there must not change that outcome
    let store = {
      tryAdmit: async () => false,
      enqueueIfRoom: async () => false, // queue is full
      reconcileStale: async () => { throw new Error('connection refused'); },
      isActive: notCalled('isActive'),
      expirePending: notCalled('expirePending'),
      releaseAndPromote: notCalled('releaseAndPromote')
    };
    let queue = buildQueue(store);
    let res = fakeRes();

    let result = await queue.admit(fakeReq(), res);
    assert.strictEqual(result, false, 'a full queue still rejects even if reconcileStale itself errors');
    assert.strictEqual(res.statusCode, 429);
    assert.strictEqual(res.headers['Retry-After'], '5');
  });

  it('fails open when isActive rejects while polling a queued request', async () => {
    let store = {
      tryAdmit: async () => false,
      enqueueIfRoom: async () => true, // successfully queued
      reconcileStale: notCalled('reconcileStale'),
      isActive: async () => { throw new Error('connection refused'); },
      expirePending: notCalled('expirePending'),
      releaseAndPromote: async () => null
    };
    let queue = buildQueue(store);

    let result = await queue.admit(fakeReq(), fakeRes());
    assert.strictEqual(result, true, 'an isActive polling error must fail open');
  });

  it('fails open when expirePending rejects after a queued request genuinely times out', async () => {
    let store = {
      tryAdmit: async () => false,
      enqueueIfRoom: async () => true,
      reconcileStale: notCalled('reconcileStale'),
      isActive: async () => false, // never promoted
      expirePending: async () => { throw new Error('connection refused'); },
      releaseAndPromote: notCalled('releaseAndPromote')
    };
    let queue = buildQueue(store, { pendingTimeoutMs: 80, pollIntervalMs: 20 });

    let result = await queue.admit(fakeReq(), fakeRes());
    assert.strictEqual(result, true, 'an expirePending error on the timeout path must fail open');
  });

  it('still reports "disconnected" (sends no response) when expirePending rejects after a client disconnect', async () => {
    let store = {
      tryAdmit: async () => false,
      enqueueIfRoom: async () => true,
      reconcileStale: notCalled('reconcileStale'),
      isActive: async () => false,
      expirePending: async () => { throw new Error('connection refused'); },
      releaseAndPromote: notCalled('releaseAndPromote')
    };
    let queue = buildQueue(store, { pendingTimeoutMs: 5000, pollIntervalMs: 20 });
    let req = fakeReq();
    let res = fakeRes();

    let admitPromise = queue.admit(req, res);
    await new Promise(resolve => setTimeout(resolve, 30));
    req.emit('close');

    let result = await admitPromise;
    assert.strictEqual(result, false);
    assert.strictEqual(res.statusCode, null, 'a disconnected client must never receive a response, error or not');
  });
});
