import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import config from '../../../src/lib/config.js';
import { Db } from '../../../src/lib/db/pool.js';
import { buildServer, shutdown } from '../../../src/server.js';
import { resetQueueSchema, resetDenylistSchema } from '../queue-test-helpers.js';
import { startServer } from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUEUE_RULES_FILE = path.join(__dirname, '..', '..', '..', 'config', 'examples', 'queue-rules.example.json');
const CACHE_RULES_FILE = path.join(__dirname, '..', '..', '..', 'config', 'examples', 'cache-rules.example.json');

function baseCfg(overrides = {}) {
  return {
    port: 0,
    upstreamUrl: '',
    clientIpHeader: '',
    postgres: config.postgres,
    queue: { enabled: false, rulesFile: '', methods: [], maxServedPerGroup: 1, maxPendingPerGroup: 1, pendingTimeoutMs: 500, pollIntervalMs: 50, ipv4PrefixLength: 24, ipv6PrefixLength: 64, staleActiveMs: 300000, sweepIntervalMs: 60000, idleGroupMs: 3600000, maxActiveDurationMs: 0, allowlist: '', denylist: { enabled: false } },
    cache: { enabled: false, rulesFile: '', dir: '', maxSizeBytes: 1024 * 1024, maxItemSizeBytes: 1024 * 1024, ttlMs: 60000, respectCacheControl: true, methods: ['GET', 'HEAD'], varyHeaders: [], keyIncludeQuery: true, sweepIntervalMs: 60000 },
    ...overrides
  };
}

describe('server bootstrap (buildServer / shutdown)', function () {
  this.timeout(20000);
  let origin, built;

  afterEach(async () => {
    if (built) {
      await shutdown(built).catch(() => {});
      built = null;
    }
    if (origin) await origin.close();
    origin = null;
  });

  it('builds a working app with both gates disabled, and shuts down cleanly', async () => {
    origin = await startServer((req, res) => { res.writeHead(200); res.end('hello'); });

    built = await buildServer(baseCfg({ upstreamUrl: origin.url }));
    assert.strictEqual(built.db, null);
    assert.strictEqual(built.queue, null);
    assert.strictEqual(built.cache, null);
    assert.ok(built.server.listening);

    let port = built.server.address().port;
    let res = await fetch(`http://127.0.0.1:${port}/anything`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'hello');

    await shutdown(built);
    assert.strictEqual(built.server.listening, false);
    built = null; // already shut down, afterEach shouldn't shut down again

    await assert.rejects(fetch(`http://127.0.0.1:${port}/anything`), 'the server must no longer accept connections after shutdown');
  });

  it('wires up a real queue against Postgres, and shutdown ends the pool', async () => {
    origin = await startServer((req, res) => { res.writeHead(200); res.end('ok'); });

    built = await buildServer(baseCfg({
      upstreamUrl: origin.url,
      queue: { enabled: true, rulesFile: QUEUE_RULES_FILE, methods: ['GET'], maxServedPerGroup: 1, maxPendingPerGroup: 1, pendingTimeoutMs: 500, pollIntervalMs: 50, ipv4PrefixLength: 24, ipv6PrefixLength: 64, staleActiveMs: 300000, sweepIntervalMs: 60000, idleGroupMs: 3600000, maxActiveDurationMs: 0, allowlist: '', denylist: { enabled: false } }
    }));

    assert.ok(built.db, 'expected a real Db instance when the queue is enabled');
    assert.ok(built.queue, 'expected a real Queue instance when the queue is enabled');

    // prove the schema was actually initialized and the pool actually works
    let resp = await built.db.query(`SELECT 1 AS ok`);
    assert.strictEqual(resp.rows[0].ok, 1);

    let dbEnded = false;
    let originalEnd = built.db.end.bind(built.db);
    built.db.end = async () => { dbEnded = true; return originalEnd(); };

    let sweepStopped = false;
    let originalStopSweeping = built.queue.stopSweeping.bind(built.queue);
    built.queue.stopSweeping = () => { sweepStopped = true; return originalStopSweeping(); };

    await shutdown(built);
    assert.strictEqual(dbEnded, true, 'shutdown must end the Postgres pool when the queue was enabled');
    assert.strictEqual(sweepStopped, true, 'shutdown must stop the queue sweep timer when the queue was enabled');
    built = null;
  });

  it('wires up a real denylist against Postgres, including the range-wide block tier', async () => {
    origin = await startServer((req, res) => { res.writeHead(200); res.end('ok'); });

    // reset so leftover rows from other test files/runs can't affect this
    // range's today-count
    let resetDb = new Db({ postgres: config.postgres });
    await resetQueueSchema(resetDb, config.postgres.schema);
    await resetDenylistSchema(resetDb, config.postgres.schema);
    await resetDb.end();

    built = await buildServer(baseCfg({
      upstreamUrl: origin.url,
      clientIpHeader: 'x-test-ip',
      queue: {
        enabled: true, rulesFile: QUEUE_RULES_FILE, methods: ['GET'], maxServedPerGroup: 0, maxPendingPerGroup: 0,
        pendingTimeoutMs: 500, pollIntervalMs: 50, ipv4PrefixLength: 24, ipv6PrefixLength: 64, staleActiveMs: 300000,
        sweepIntervalMs: 60000, idleGroupMs: 3600000, maxActiveDurationMs: 0, allowlist: '',
        denylist: {
          enabled: true, dailyThreshold: 1000, windowDays: 14, exceedThreshold: 1000, blockDays: 30,
          rangeIpThreshold: 2, rangeBlockHours: 24, sweepIntervalMs: 60000, pruneRetentionMs: 30 * 24 * 60 * 60 * 1000
        }
      }
    }));

    assert.ok(built.denylist, 'expected a real Denylist instance when queue.denylist.enabled is true');

    let port = built.server.address().port;

    // 3 distinct ips in the same /24, each denied once by the saturated queue
    for (let ip of ['192.0.2.11', '192.0.2.12', '192.0.2.13']) {
      let r = await fetch(`http://127.0.0.1:${port}/file.pdf`, { headers: { 'x-test-ip': ip } });
      assert.strictEqual(r.status, 429);
    }

    // this is the regression guard for the rangeIpThreshold/rangeThreshold
    // config key mismatch bug: it only passes if Denylist's config actually
    // receives the real rangeIpThreshold value threaded through from
    // config.js/buildServer, rather than a hand-built test config
    let fresh = await fetch(`http://127.0.0.1:${port}/file.pdf`, { headers: { 'x-test-ip': '192.0.2.99' } });
    assert.strictEqual(fresh.status, 429);
    assert.ok((await fresh.text()).includes('blocked'), 'expected a never-before-seen ip in the now-blocked range to be rejected by the pre-check');

    let sweepStopped = false;
    let originalStopSweeping = built.denylist.stopSweeping.bind(built.denylist);
    built.denylist.stopSweeping = () => { sweepStopped = true; return originalStopSweeping(); };

    await shutdown(built);
    assert.strictEqual(sweepStopped, true, 'shutdown must stop the denylist sweep timer when it was enabled');
    built = null;
  });

  it('wires up a real disk cache, and shutdown stops its sweep timer', async () => {
    origin = await startServer((req, res) => { res.writeHead(200); res.end('ok'); });
    let dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccnq-bootstrap-cache-'));

    built = await buildServer(baseCfg({
      upstreamUrl: origin.url,
      cache: { enabled: true, rulesFile: CACHE_RULES_FILE, dir, maxSizeBytes: 1024 * 1024, maxItemSizeBytes: 1024 * 1024, ttlMs: 60000, respectCacheControl: true, methods: ['GET'], varyHeaders: [], keyIncludeQuery: true, sweepIntervalMs: 60000 }
    }));

    assert.ok(built.cache, 'expected a real DiskCache instance when the cache is enabled');
    assert.strictEqual(built.db, null, 'the cache alone should not require Postgres');

    let sweepStopped = false;
    let originalStop = built.cache.stopSweeping.bind(built.cache);
    built.cache.stopSweeping = () => { sweepStopped = true; return originalStop(); };

    await shutdown(built);
    assert.strictEqual(sweepStopped, true, 'shutdown must stop the cache sweep timer when the cache was enabled');
    built = null;
  });
});
