import assert from 'assert';
import config from '../../../src/lib/config.js';
import { Db } from '../../../src/lib/db/pool.js';
import { QueueStore } from '../../../src/lib/queue/store.js';
import { DenylistStore } from '../../../src/lib/queue/denylist-store.js';
import { Queue } from '../../../src/lib/queue/index.js';
import { Denylist } from '../../../src/lib/queue/denylist.js';
import { createAllowlist } from '../../../src/lib/queue/allowlist.js';
import { createApp } from '../../../src/app.js';
import { resetQueueSchema, resetDenylistSchema } from '../queue-test-helpers.js';
import { startServer } from './helpers.js';

const QUEUE_RULES = [[{ target: 'path', matchType: 'startsWith', value: '/' }]];
const fakeLogger = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, fatal() {} };
const DAY_MS = 24 * 60 * 60 * 1000;

describe('e2e: denylist gate', function () {
  this.timeout(20000);
  let db, origin, app, appServer;

  before(async () => {
    db = new Db({ postgres: config.postgres });
  });

  beforeEach(async () => {
    await resetQueueSchema(db, config.postgres.schema);
    await resetDenylistSchema(db, config.postgres.schema);
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

  function buildGates(overrides = {}) {
    let allowlist = createAllowlist(overrides.allowlist || '');

    let queue = new Queue({
      config: {
        methods: [], maxServedPerGroup: 0, maxPendingPerGroup: 0, pendingTimeoutMs: 1000, pollIntervalMs: 50,
        ipv4PrefixLength: 24, ipv6PrefixLength: 64, staleActiveMs: 300000, clientIpHeader: 'x-test-ip'
      },
      store: new QueueStore({ db, schema: config.postgres.schema }),
      allowlist,
      rules: QUEUE_RULES,
      logger: fakeLogger
    });

    let denylist = new Denylist({
      config: {
        dailyThreshold: 1, windowDays: 14, exceedThreshold: 1, blockMs: 30 * DAY_MS,
        rangeThreshold: 1000, rangeBlockMs: DAY_MS, ipv4PrefixLength: 24, ipv6PrefixLength: 64,
        clientIpHeader: 'x-test-ip',
        ...overrides.denylistConfig
      },
      store: new DenylistStore({ db, schema: config.postgres.schema }),
      allowlist,
      logger: fakeLogger
    });

    return { queue, denylist };
  }

  it('a queue 429 is recorded, immediately blocking the ip, which the pre-check then serves instead of the queue', async () => {
    let hitCount = 0;
    origin = await startServer((req, res) => { hitCount++; res.writeHead(200); res.end('ok'); });

    let { queue, denylist } = buildGates();
    app = createApp({ cache: null, queue, denylist, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let headers = { 'x-test-ip': '198.51.100.5' };

    let r1 = await fetch(`${appServer.url}/file.pdf`, { headers });
    assert.strictEqual(r1.status, 429);
    assert.ok((await r1.text()).includes('concurrent'), 'first denial should come from the queue itself');

    let r2 = await fetch(`${appServer.url}/file.pdf`, { headers });
    assert.strictEqual(r2.status, 429);
    let body2 = await r2.text();
    assert.ok(body2.includes('blocked'), 'second request should be rejected by the denylist pre-check, not the queue');
    let retryAfter = Number(r2.headers.get('retry-after'));
    assert.ok(retryAfter > 1000, `expected a multi-day Retry-After, got ${retryAfter}`);

    assert.strictEqual(hitCount, 0, 'the origin should never have been reached');
  });

  it('lifting the block (blocked_until in the past) falls back through to the queue\'s own decision', async () => {
    origin = await startServer((req, res) => { res.writeHead(200); res.end('ok'); });

    let { queue, denylist } = buildGates();
    app = createApp({ cache: null, queue, denylist, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let headers = { 'x-test-ip': '198.51.100.6' };

    await fetch(`${appServer.url}/file.pdf`, { headers }); // triggers the block
    let blocked = await fetch(`${appServer.url}/file.pdf`, { headers });
    assert.strictEqual(blocked.status, 429);
    assert.ok((await blocked.text()).includes('blocked'));

    await db.query(
      `UPDATE ${config.postgres.schema}.ip_block SET blocked_until = NOW() - interval '1 second' WHERE ip = $1`,
      [headers['x-test-ip']]
    );

    let after = await fetch(`${appServer.url}/file.pdf`, { headers });
    assert.strictEqual(after.status, 429);
    assert.ok((await after.text()).includes('concurrent'), 'with the block lifted, the queue\'s own (still-saturated) 429 should serve the request again');
  });

  it('an allowlisted ip is never blocked, even with a pre-existing ip_block row', async () => {
    let hitCount = 0;
    origin = await startServer((req, res) => { hitCount++; res.writeHead(200); res.end('ok'); });

    let allowedIp = '203.0.113.50';
    let { queue, denylist } = buildGates({ allowlist: allowedIp });
    app = createApp({ cache: null, queue, denylist, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    await db.query(
      `INSERT INTO ${config.postgres.schema}.ip_block (ip, blocked_until) VALUES ($1, NOW() + interval '1 hour')`,
      [allowedIp]
    );

    let r = await fetch(`${appServer.url}/file.pdf`, { headers: { 'x-test-ip': allowedIp } });
    assert.strictEqual(r.status, 200, 'an allowlisted ip bypasses the denylist pre-check regardless of ip_block state');
    assert.strictEqual(hitCount, 1);
  });

  it('more than rangeThreshold distinct ips denied in the same /24 on the same day blocks a never-seen ip in that range', async () => {
    let hitCount = 0;
    origin = await startServer((req, res) => { hitCount++; res.writeHead(200); res.end('ok'); });

    let { queue, denylist } = buildGates({
      // dailyThreshold/exceedThreshold kept high so no individual ip ever
      // self-triggers an ip-level block in this test - only the range tier fires
      denylistConfig: { dailyThreshold: 1000, exceedThreshold: 1000, rangeThreshold: 3, rangeBlockMs: DAY_MS }
    });
    app = createApp({ cache: null, queue, denylist, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let rangeIps = ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4'];
    for (let ip of rangeIps) {
      let r = await fetch(`${appServer.url}/file.pdf`, { headers: { 'x-test-ip': ip } });
      assert.strictEqual(r.status, 429);
      assert.ok((await r.text()).includes('concurrent'), `${ip}'s own first request should be denied by the queue, not yet by a range block`);
    }

    // the 4th distinct ip pushed the group's today-count to 4, past rangeThreshold=3;
    // a brand-new ip in that same /24 should now be rejected by the pre-check
    let freshIp = '192.0.2.99';
    let r = await fetch(`${appServer.url}/file.pdf`, { headers: { 'x-test-ip': freshIp } });
    assert.strictEqual(r.status, 429);
    assert.ok((await r.text()).includes('blocked'), 'a never-before-seen ip in a blocked range should be rejected by the pre-check');

    assert.strictEqual(hitCount, 0, 'the origin should never have been reached');
  });

  it('a range block does not affect ips in a different /24', async () => {
    origin = await startServer((req, res) => { res.writeHead(200); res.end('ok'); });

    let { queue, denylist } = buildGates({
      denylistConfig: { dailyThreshold: 1000, exceedThreshold: 1000, rangeThreshold: 3, rangeBlockMs: DAY_MS }
    });
    app = createApp({ cache: null, queue, denylist, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    for (let ip of ['192.0.2.1', '192.0.2.2', '192.0.2.3', '192.0.2.4']) {
      await fetch(`${appServer.url}/file.pdf`, { headers: { 'x-test-ip': ip } });
    }

    let r = await fetch(`${appServer.url}/file.pdf`, { headers: { 'x-test-ip': '203.0.113.77' } });
    assert.strictEqual(r.status, 429);
    assert.ok((await r.text()).includes('concurrent'), 'an ip outside the blocked range should still be denied by the queue itself, not the range block');
  });
});
