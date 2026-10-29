import assert from 'assert';
import { EventEmitter } from 'events';
import config from '../../../src/lib/config.js';
import { Db } from '../../../src/lib/db/pool.js';
import { QueueStore } from '../../../src/lib/queue/store.js';
import { Queue } from '../../../src/lib/queue/index.js';
import { createAllowlist } from '../../../src/lib/queue/allowlist.js';
import { resetQueueSchema } from '../queue-test-helpers.js';

const ALWAYS_IN_SCOPE_RULES = [[{ target: 'path', matchType: 'startsWith', value: '/' }]];
const fakeLogger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} };

function fakeReq({ remoteAddress = '203.0.113.1', path = '/binary/file.pdf' } = {}) {
  let req = new EventEmitter();
  req.method = 'GET';
  req.path = path;
  req.headers = {};
  req.socket = { remoteAddress };
  return req;
}

function fakeRes() {
  let res = new EventEmitter();
  res.statusCode = null;
  res.headers = {};
  res.body = null;
  res.destroyed = false;
  res.status = (code) => { res.statusCode = code; return res; };
  res.set = (name, value) => { res.headers[name] = value; return res; };
  res.send = (body) => { res.body = body; return res; };
  // mirrors http.ServerResponse: destroying an in-flight response emits 'close'
  res.destroy = () => { if (res.destroyed) return; res.destroyed = true; res.emit('close'); };
  return res;
}

function buildQueue(db, overrides = {}) {
  let store = new QueueStore({ db, schema: config.postgres.schema });
  let allowlist = createAllowlist(overrides.allowlist || '');
  return new Queue({
    config: {
      methods: [],
      maxServedPerGroup: 2,
      maxPendingPerGroup: 2,
      pendingTimeoutMs: 500,
      pollIntervalMs: 50,
      ipv4PrefixLength: 24,
      ipv6PrefixLength: 64,
      staleActiveMs: 300000,
      clientIpHeader: '',
      ...overrides.config
    },
    store,
    allowlist,
    rules: ALWAYS_IN_SCOPE_RULES,
    logger: fakeLogger
  });
}

describe('Queue admission gate (Postgres)', function () {
  this.timeout(20000);
  let db;

  before(async () => {
    db = new Db({ postgres: config.postgres });
  });

  beforeEach(async () => {
    await resetQueueSchema(db, config.postgres.schema);
  });

  after(async () => {
    await db.end();
  });

  it('admits up to maxServed immediately, queues the rest, and promotes on release', async () => {
    let queue = buildQueue(db); // maxServed=2, maxPending=2

    // Each test below uses its own distinct ip (and thus ip_group) rather
    // than sharing the fakeReq() default. Releasing an active slot triggers
    // a fire-and-forget store.releaseAndPromote() call (see
    // Queue._attachReleaseHooks) that this test never awaits, so it can
    // still be in flight when the NEXT test's beforeEach truncate runs;
    // reusing an ip group across tests risks that stale call landing after
    // the next test has already seeded fresh state for the same group and
    // corrupting its active_count.

    // 6 requests from the same ip group: 2 should admit immediately, 2 should
    // queue and later be promoted once slots free up, 2 should 429
    let reqs = Array.from({ length: 6 }, () => fakeReq({ remoteAddress: '203.0.113.10' }));
    let resArr = reqs.map(() => fakeRes());
    let admitPromises = reqs.map((req, i) => queue.admit(req, resArr[i]));

    // give the immediate admits/enqueues/rejections a moment to settle
    await new Promise(resolve => setTimeout(resolve, 150));

    // which 2 of the 6 concurrent requests actually won the active slots is
    // not deterministic from the caller's perspective (it's decided by
    // Postgres row-lock ordering), so emit 'finish' on all of them: it's a
    // harmless no-op on requests that never got a release hook attached
    // (the queued and rejected ones), and releases whichever 2 are actually
    // active, which is what triggers the queued ones' promotion
    resArr.forEach(res => res.emit('finish'));

    let results = await Promise.all(admitPromises);
    let trueCount = results.filter(r => r === true).length;
    let falseCount = results.filter(r => r === false).length;

    assert.strictEqual(trueCount, 4, 'expected 2 immediate admits + 2 promoted-from-queue admits');
    assert.strictEqual(falseCount, 2, 'expected 2 rejections once the queue was also full');

    let rejected = resArr.filter(res => res.statusCode === 429);
    assert.strictEqual(rejected.length, 2);
    rejected.forEach(res => assert.strictEqual(res.headers['Retry-After'], '5'));
  });

  it('cleans up a pending row when the client disconnects while queued', async () => {
    let queue = buildQueue(db, {
      config: { maxServedPerGroup: 1, maxPendingPerGroup: 1, pendingTimeoutMs: 5000, pollIntervalMs: 50 }
    });

    let req1 = fakeReq({ remoteAddress: '203.0.113.20' });
    let res1 = fakeRes();
    let req2 = fakeReq({ remoteAddress: '203.0.113.20' });
    let res2 = fakeRes();

    let admit1 = queue.admit(req1, res1); // takes the one active slot
    await new Promise(resolve => setTimeout(resolve, 100));

    let admit2 = queue.admit(req2, res2); // queues behind req1
    await new Promise(resolve => setTimeout(resolve, 100));

    req2.emit('close'); // client gives up while waiting

    let [result1, result2] = await Promise.all([admit1, admit2]);
    assert.strictEqual(result1, true);
    assert.strictEqual(result2, false);
    assert.strictEqual(res2.statusCode, null, 'a disconnected client should never receive a response');
  });

  it('rejects a queued request with 429 once it genuinely times out waiting (never promoted)', async () => {
    let queue = buildQueue(db, {
      config: { maxServedPerGroup: 1, maxPendingPerGroup: 1, pendingTimeoutMs: 150, pollIntervalMs: 20 }
    });

    let req1 = fakeReq({ remoteAddress: '203.0.113.35' });
    let res1 = fakeRes();
    let req2 = fakeReq({ remoteAddress: '203.0.113.35' });
    let res2 = fakeRes();

    // takes the one active slot; its admit() resolves immediately, but the
    // slot is deliberately never released (no 'finish'/'close' emitted), so
    // req2 below has nothing to be promoted into
    assert.strictEqual(await queue.admit(req1, res1), true);

    let start = Date.now();
    let result2 = await queue.admit(req2, res2); // queues behind req1, nobody ever frees a slot for it
    let elapsed = Date.now() - start;

    assert.strictEqual(result2, false, 'a request that times out while queued must be rejected');
    assert.ok(elapsed >= 150, `expected to have genuinely waited out pendingTimeoutMs (150ms), only waited ${elapsed}ms`);
    assert.strictEqual(res2.statusCode, 429, 'a timeout rejection is a real 429 response, unlike a disconnect');
    assert.strictEqual(res2.headers['Retry-After'], '5');
  });

  it('rejects the current caller even when reconcileStale frees a slot for the next one', async () => {
    let queue = buildQueue(db, {
      config: { maxServedPerGroup: 1, maxPendingPerGroup: 0, pendingTimeoutMs: 500, pollIntervalMs: 50, staleActiveMs: 10 }
    });

    let group = queue.getIpGroup(fakeReq({ remoteAddress: '203.0.113.30' }));

    // seed a stale active row directly, simulating an instance that crashed
    // mid-request and never released its slot
    await db.query(
      `INSERT INTO ${config.postgres.schema}.group_state (ip_group, active_count) VALUES ($1, 1)
       ON CONFLICT (ip_group) DO UPDATE SET active_count = 1`,
      [group]
    );
    await db.query(
      `INSERT INTO ${config.postgres.schema}.active_request (request_id, ip_group, created) VALUES ($1, $2, NOW() - interval '1 hour')`,
      ['stale-request', group]
    );

    await new Promise(resolve => setTimeout(resolve, 20)); // ensure staleActiveMs has elapsed

    let currentCallerResult = await queue.admit(fakeReq({ remoteAddress: '203.0.113.30' }), fakeRes());
    assert.strictEqual(currentCallerResult, false, 'the current caller still gets rejected even though reconcileStale just ran');

    let nextCallerResult = await queue.admit(fakeReq({ remoteAddress: '203.0.113.30' }), fakeRes());
    assert.strictEqual(nextCallerResult, true, 'the next caller should succeed now that the stale row is gone');
  });

  it('bypasses the gate entirely for allowlisted ips, even at zero capacity', async () => {
    let queue = buildQueue(db, { allowlist: '203.0.113.1', config: { maxServedPerGroup: 0, maxPendingPerGroup: 0 } });
    let result = await queue.admit(fakeReq({ remoteAddress: '203.0.113.1' }), fakeRes());
    assert.strictEqual(result, true);
  });

  it('bypasses the gate entirely for a method not in the configured methods list, even at zero capacity', async () => {
    let store = new QueueStore({ db, schema: config.postgres.schema });
    let queue = new Queue({
      config: {
        methods: ['GET'], maxServedPerGroup: 0, maxPendingPerGroup: 0, pendingTimeoutMs: 500, pollIntervalMs: 50,
        ipv4PrefixLength: 24, ipv6PrefixLength: 64, staleActiveMs: 300000, clientIpHeader: ''
      },
      store,
      allowlist: createAllowlist(''),
      rules: ALWAYS_IN_SCOPE_RULES,
      logger: fakeLogger
    });

    let postReq = fakeReq({ remoteAddress: '203.0.113.50' });
    postReq.method = 'POST';
    assert.strictEqual(await queue.admit(postReq, fakeRes()), true, 'POST is not in methods:["GET"], so it must bypass the gate');

    let getReq = fakeReq({ remoteAddress: '203.0.113.50' });
    assert.strictEqual(await queue.admit(getReq, fakeRes()), false, 'GET is in methods:["GET"] and in scope, so zero capacity must still reject it');
  });

  it('bypasses the gate entirely for requests outside the ruleset, even at zero capacity', async () => {
    let store = new QueueStore({ db, schema: config.postgres.schema });
    let queue = new Queue({
      config: {
        methods: [], maxServedPerGroup: 0, maxPendingPerGroup: 0, pendingTimeoutMs: 500, pollIntervalMs: 50,
        ipv4PrefixLength: 24, ipv6PrefixLength: 64, staleActiveMs: 300000, clientIpHeader: ''
      },
      store,
      allowlist: createAllowlist(''),
      rules: [[{ target: 'path', matchType: 'startsWith', value: '/never-matches' }]],
      logger: fakeLogger
    });

    let result = await queue.admit(fakeReq({ path: '/something-else' }), fakeRes());
    assert.strictEqual(result, true);
  });

  it('force-disconnects an active request once maxActiveDurationMs elapses', async () => {
    let queue = buildQueue(db, { config: { maxServedPerGroup: 1, maxPendingPerGroup: 1, maxActiveDurationMs: 50 } });

    let req = fakeReq({ remoteAddress: '203.0.113.60' });
    let res = fakeRes();

    assert.strictEqual(await queue.admit(req, res), true);
    assert.strictEqual(res.destroyed, false);

    await new Promise(resolve => setTimeout(resolve, 150));

    assert.strictEqual(res.destroyed, true, 'the response should be force-destroyed after exceeding maxActiveDurationMs');

    let group = queue.getIpGroup(req);
    let resp = await db.query(`SELECT active_count FROM ${config.postgres.schema}.group_state WHERE ip_group = $1`, [group]);
    assert.strictEqual(resp.rows[0].active_count, 0, 'the active slot should be released once destroyed');
  });

  it('does not force-disconnect a request that finishes before maxActiveDurationMs', async () => {
    let queue = buildQueue(db, { config: { maxServedPerGroup: 1, maxPendingPerGroup: 1, maxActiveDurationMs: 200 } });

    let req = fakeReq({ remoteAddress: '203.0.113.61' });
    let res = fakeRes();

    assert.strictEqual(await queue.admit(req, res), true);
    res.emit('finish');

    await new Promise(resolve => setTimeout(resolve, 250));

    assert.strictEqual(res.destroyed, false, 'a request that already finished must never be force-destroyed later');
  });

  it('leaves maxActiveDurationMs disabled (0) as a no-op', async () => {
    let queue = buildQueue(db, { config: { maxServedPerGroup: 1, maxPendingPerGroup: 1, maxActiveDurationMs: 0 } });

    let req = fakeReq({ remoteAddress: '203.0.113.62' });
    let res = fakeRes();

    assert.strictEqual(await queue.admit(req, res), true);
    await new Promise(resolve => setTimeout(resolve, 100));

    assert.strictEqual(res.destroyed, false, 'maxActiveDurationMs=0 must never force-disconnect');
  });
});

describe('Queue background sweeping', function () {
  this.timeout(20000);
  let db;

  before(async () => {
    db = new Db({ postgres: config.postgres });
  });

  beforeEach(async () => {
    await resetQueueSchema(db, config.postgres.schema);
  });

  after(async () => {
    await db.end();
  });

  it('startSweeping runs reconcileStale and pruneIdleGroups on an interval, and stopSweeping stops it', async () => {
    let queue = buildQueue(db, { config: { sweepIntervalMs: 30, staleActiveMs: 300000, idleGroupMs: 3600000 } });

    let reconcileCalls = 0;
    let pruneCalls = 0;
    queue.store.reconcileStale = async () => { reconcileCalls++; return 0; };
    queue.store.pruneIdleGroups = async () => { pruneCalls++; return 0; };

    queue.startSweeping();
    queue.startSweeping(); // idempotent: must not create a second timer

    await new Promise(resolve => setTimeout(resolve, 110));
    queue.stopSweeping();

    assert.ok(reconcileCalls >= 2, `expected multiple sweep ticks, got ${reconcileCalls}`);
    assert.ok(pruneCalls >= 2, `expected multiple sweep ticks, got ${pruneCalls}`);

    let callsAtStop = reconcileCalls;
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.strictEqual(reconcileCalls, callsAtStop, 'no further ticks should run after stopSweeping');

    queue.stopSweeping(); // idempotent: must not throw when already stopped
  });

  it('a scheduled sweep error on one store call does not block the other', async () => {
    let queue = buildQueue(db, { config: { sweepIntervalMs: 30 } });

    let pruneCalls = 0;
    queue.store.reconcileStale = async () => { throw new Error('boom'); };
    queue.store.pruneIdleGroups = async () => { pruneCalls++; return 0; };

    queue.startSweeping();
    await new Promise(resolve => setTimeout(resolve, 80));
    queue.stopSweeping();

    assert.ok(pruneCalls >= 1, 'pruneIdleGroups must still run even when reconcileStale throws');
  });
});
