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

describe('e2e: queue gate', function () {
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
        methods: [], maxServedPerGroup: 1, maxPendingPerGroup: 1, pendingTimeoutMs: 2000, pollIntervalMs: 50,
        ipv4PrefixLength: 24, ipv6PrefixLength: 64, staleActiveMs: 300000, clientIpHeader: '',
        ...overrides.config
      },
      store,
      allowlist: createAllowlist(overrides.allowlist || ''),
      rules: overrides.rules || QUEUE_RULES,
      logger: fakeLogger
    });
  }

  it('saturates: one immediate success, one delayed success after release, one 429', async () => {
    let releaseFirst;
    let firstGate = new Promise(resolve => { releaseFirst = resolve; });
    let callIndex = 0;

    origin = await startServer(async (req, res) => {
      callIndex++;
      if (callIndex === 1) await firstGate; // hold the first request open until we say so
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok-' + callIndex);
    });

    let queue = buildQueue();
    app = createApp({ cache: null, queue, upstreamUrl: origin.url, logger: fakeLogger });
    appServer = await startServer(app);

    let p1 = fetch(`${appServer.url}/file.pdf`);
    await new Promise(resolve => setTimeout(resolve, 400)); // let p1 claim the active slot

    let p2 = fetch(`${appServer.url}/file.pdf`); // queue is full of active, so this queues
    await new Promise(resolve => setTimeout(resolve, 400));

    let r3 = await fetch(`${appServer.url}/file.pdf`); // active full AND pending full -> 429
    assert.strictEqual(r3.status, 429);
    assert.ok(r3.headers.get('retry-after'));

    releaseFirst(); // let the first request's origin call finish, freeing its active slot

    let [r1, r2] = await Promise.all([p1, p2]);
    assert.strictEqual(r1.status, 200);
    assert.strictEqual(r2.status, 200);
  });
});
