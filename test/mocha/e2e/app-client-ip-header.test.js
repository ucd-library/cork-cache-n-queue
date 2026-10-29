import assert from 'assert';
import config from '../../../src/lib/config.js';
import { Db } from '../../../src/lib/db/pool.js';
import { QueueStore } from '../../../src/lib/queue/store.js';
import { Queue } from '../../../src/lib/queue/index.js';
import { createAllowlist } from '../../../src/lib/queue/allowlist.js';
import { createApp } from '../../../src/app.js';
import { resetQueueSchema } from '../queue-test-helpers.js';
import { startServer } from './helpers.js';

const QUEUE_RULES = [[{ target: 'path', matchType: 'startsWith', value: '/' }]];
const fakeLogger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} };

describe('e2e: configurable client-ip header', function () {
  this.timeout(20000);
  let db, origin, app, appServer;

  before(async () => {
    db = new Db({ postgres: config.postgres });
  });

  beforeEach(async () => {
    await resetQueueSchema(db, config.postgres.schema);
  });

  afterEach(async () => {
    if (appServer) await appServer.close();
    if (origin) await origin.close();
    appServer = null;
    origin = null;
  });

  after(async () => {
    await db.end();
  });

  function buildQueue() {
    let store = new QueueStore({ db, schema: config.postgres.schema });
    return new Queue({
      config: {
        methods: [], maxServedPerGroup: 1, maxPendingPerGroup: 0, pendingTimeoutMs: 1000, pollIntervalMs: 50,
        ipv4PrefixLength: 24, ipv6PrefixLength: 64, staleActiveMs: 300000, clientIpHeader: 'x-test-ip'
      },
      store,
      allowlist: createAllowlist(''),
      rules: QUEUE_RULES,
      logger: fakeLogger
    });
  }

  function buildHeldOrigin() {
    let release;
    let gate = new Promise(resolve => { release = resolve; });
    let hitCount = 0;
    return {
      release,
      server: startServer(async (req, res) => {
        hitCount++;
        if (hitCount === 1) await gate;
        res.writeHead(200);
        res.end('ok');
      })
    };
  }

  it('treats different configured-header values as separate ip groups', async () => {
    let held = buildHeldOrigin();
    origin = await held.server;

    let queue = buildQueue();
    app = createApp({ cache: null, queue, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let p1 = fetch(`${appServer.url}/file.pdf`, { headers: { 'x-test-ip': '203.0.113.1' } });
    await new Promise(resolve => setTimeout(resolve, 400));

    // a different header value is a different group, so it should admit
    // immediately even while the first group's one slot is still held
    let r2 = await fetch(`${appServer.url}/file.pdf`, { headers: { 'x-test-ip': '198.51.100.1' } });
    assert.strictEqual(r2.status, 200);

    held.release();
    let r1 = await p1;
    assert.strictEqual(r1.status, 200);
  });

  it('treats the same configured-header value as one shared ip group', async () => {
    let held = buildHeldOrigin();
    origin = await held.server;

    let queue = buildQueue();
    app = createApp({ cache: null, queue, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    // deliberately a different /24 than the previous test uses (not just a
    // different last octet, which would still mask to the same /24 group):
    // releasing an active slot triggers a fire-and-forget
    // store.releaseAndPromote() call (see Queue._attachReleaseHooks) that
    // isn't awaited by the request pipeline, so it can still be in flight
    // when this test's beforeEach truncate runs; reusing an ip group across
    // tests risks that stale call landing after this test has already
    // seeded fresh state for the same group and corrupting its active_count
    let p1 = fetch(`${appServer.url}/file.pdf`, { headers: { 'x-test-ip': '192.0.2.1' } });
    await new Promise(resolve => setTimeout(resolve, 400));

    // same header value as p1 -> same group, whose one slot is already held
    // and whose queue has no room (maxPendingPerGroup=0) -> 429
    let r2 = await fetch(`${appServer.url}/file.pdf`, { headers: { 'x-test-ip': '192.0.2.1' } });
    assert.strictEqual(r2.status, 429);

    held.release();
    let r1 = await p1;
    assert.strictEqual(r1.status, 200);
  });
});
