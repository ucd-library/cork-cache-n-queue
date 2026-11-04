import assert from 'assert';
import { Denylist } from '../../../src/lib/queue/denylist.js';
import { createAllowlist } from '../../../src/lib/queue/allowlist.js';

// Pure unit tests against a fake store - no Postgres/Docker needed. These
// verify the documented "fail-open" guarantee (a Postgres error must never
// block a request, nor ever reject out of recordDenial) and the allowlist
// bypass, which skips the store entirely.

const loggedErrors = [];
const fakeLogger = {
  info() {}, warn() {}, debug() {}, trace() {}, fatal() {},
  error(...args) { loggedErrors.push(args); }
};

function notCalled(name) {
  return async () => { throw new Error(`${name} should not have been called on this code path`); };
}

function buildDenylist(store, overrides = {}) {
  return new Denylist({
    config: {
      dailyThreshold: 25, windowDays: 14, exceedThreshold: 5, blockMs: 1000,
      rangeIpThreshold: 25, rangeBlockMs: 1000, ipv4PrefixLength: 24, ipv6PrefixLength: 64,
      clientIpHeader: '',
      ...overrides
    },
    store,
    allowlist: createAllowlist(overrides.allowlistEntries ?? ''),
    logger: fakeLogger
  });
}

describe('Denylist fail-open behavior (fake store, no Postgres)', () => {

  beforeEach(() => {
    loggedErrors.length = 0;
  });

  it('isBlocked fails open (null) and logs when the store rejects', async () => {
    let store = { isBlocked: async () => { throw new Error('connection refused'); }, recordDenial: notCalled('recordDenial') };
    let denylist = buildDenylist(store);

    let result = await denylist.isBlocked('203.0.113.1');
    assert.strictEqual(result, null);
    assert.strictEqual(loggedErrors.length, 1);
  });

  it('recordDenial never rejects and logs when the store rejects', async () => {
    let store = { isBlocked: notCalled('isBlocked'), recordDenial: async () => { throw new Error('connection refused'); } };
    let denylist = buildDenylist(store);

    await assert.doesNotReject(denylist.recordDenial('203.0.113.1'));
    assert.strictEqual(loggedErrors.length, 1);
  });

  it('isBlocked converts a future blocked_until into whole seconds remaining (minimum 1)', async () => {
    let store = { isBlocked: async () => new Date(Date.now() + 2500), recordDenial: notCalled('recordDenial') };
    let denylist = buildDenylist(store);

    let result = await denylist.isBlocked('203.0.113.1');
    assert.strictEqual(result, 3);
  });

  it('isBlocked returns null when the store reports no block', async () => {
    let store = { isBlocked: async () => null, recordDenial: notCalled('recordDenial') };
    let denylist = buildDenylist(store);

    assert.strictEqual(await denylist.isBlocked('203.0.113.1'), null);
  });

  it('recordBlockedRequest never rejects and logs when the store rejects', async () => {
    let store = { isBlocked: notCalled('isBlocked'), recordDenial: notCalled('recordDenial'), incrementDenialCount: async () => { throw new Error('connection refused'); } };
    let denylist = buildDenylist(store);

    await assert.doesNotReject(denylist.recordBlockedRequest('203.0.113.1'));
    assert.strictEqual(loggedErrors.length, 1);
  });

  it('an allowlisted ip never touches the store, for isBlocked, recordDenial, or recordBlockedRequest', async () => {
    let store = { isBlocked: notCalled('isBlocked'), recordDenial: notCalled('recordDenial'), incrementDenialCount: notCalled('incrementDenialCount') };
    let denylist = buildDenylist(store, { allowlistEntries: '203.0.113.1' });

    assert.strictEqual(await denylist.isBlocked('203.0.113.1'), null);
    await assert.doesNotReject(denylist.recordDenial('203.0.113.1'));
    await assert.doesNotReject(denylist.recordBlockedRequest('203.0.113.1'));
  });
});
