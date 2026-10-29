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

describe('e2e: queue allowlist and out-of-scope bypass', function () {
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

  function buildQueue(overrides = {}) {
    let store = new QueueStore({ db, schema: config.postgres.schema });
    return new Queue({
      config: {
        methods: [], maxServedPerGroup: 0, maxPendingPerGroup: 0, pendingTimeoutMs: 1000, pollIntervalMs: 50,
        ipv4PrefixLength: 24, ipv6PrefixLength: 64, staleActiveMs: 300000, clientIpHeader: '',
        ...overrides.config
      },
      store,
      allowlist: createAllowlist(overrides.allowlist || ''),
      rules: overrides.rules || QUEUE_RULES,
      logger: fakeLogger
    });
  }

  it('allowlisted client ips bypass the gate even at zero capacity', async () => {
    origin = await startServer((req, res) => { res.writeHead(200); res.end('ok'); });
    let queue = buildQueue({ allowlist: '127.0.0.1' });
    app = createApp({ cache: null, queue, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let results = await Promise.all(Array.from({ length: 5 }, () => fetch(`${appServer.url}/file.pdf`)));
    results.forEach(r => assert.strictEqual(r.status, 200));
  });

  it('requests outside the ruleset bypass the gate even at zero capacity', async () => {
    origin = await startServer((req, res) => { res.writeHead(200); res.end('ok'); });
    let queue = buildQueue({ rules: [[{ target: 'path', matchType: 'startsWith', value: '/never-matches' }]] });
    app = createApp({ cache: null, queue, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let results = await Promise.all(Array.from({ length: 5 }, () => fetch(`${appServer.url}/anything`)));
    results.forEach(r => assert.strictEqual(r.status, 200));
  });

  it('a non-allowlisted, in-scope ip is rejected at zero capacity', async () => {
    origin = await startServer((req, res) => { res.writeHead(200); res.end('ok'); });
    let queue = buildQueue(); // no allowlist, in-scope rules, zero capacity
    app = createApp({ cache: null, queue, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let r = await fetch(`${appServer.url}/file.pdf`);
    assert.strictEqual(r.status, 429);
  });
});
