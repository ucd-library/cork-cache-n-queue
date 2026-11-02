import assert from 'assert';
import crypto from 'crypto';
import config from '../../../src/lib/config.js';
import { Db } from '../../../src/lib/db/pool.js';
import { DenylistStore } from '../../../src/lib/queue/denylist-store.js';
import { resetDenylistSchema } from '../queue-test-helpers.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describe('DenylistStore (Postgres)', function () {
  this.timeout(20000);

  let db, store;

  before(async () => {
    db = new Db({ postgres: config.postgres });
    store = new DenylistStore({ db, schema: config.postgres.schema });
  });

  beforeEach(async () => {
    await resetDenylistSchema(db, config.postgres.schema);
  });

  after(async () => {
    await db.end();
  });

  function ip() {
    return 'test-ip-' + crypto.randomUUID();
  }

  // seed a historical ip_denial_count row directly, bypassing record_ip_denial,
  // so exceedance-day logic can be tested without needing real time to pass
  async function seedDay(testIp, daysAgo, count) {
    await db.query(
      `INSERT INTO ${config.postgres.schema}.ip_denial_count (ip, day, count)
       VALUES ($1, (NOW() AT TIME ZONE 'UTC')::date - $2::int, $3)`,
      [testIp, daysAgo, count]
    );
  }

  it('recordDenial increments today\'s counter across repeated calls for the same ip', async () => {
    let testIp = ip();

    await store.recordDenial(testIp, 1000, 14, 1000, DAY_MS);
    await store.recordDenial(testIp, 1000, 14, 1000, DAY_MS);
    await store.recordDenial(testIp, 1000, 14, 1000, DAY_MS);

    let resp = await db.query(
      `SELECT count FROM ${config.postgres.schema}.ip_denial_count WHERE ip = $1 AND day = (NOW() AT TIME ZONE 'UTC')::date`,
      [testIp]
    );
    assert.strictEqual(resp.rows[0].count, 3);
  });

  it('returns false until enough threshold-exceeded days accumulate within the window, then true', async () => {
    let testIp = ip();

    // 4 historical bad days - not yet enough to trigger a block at exceedThreshold=5
    for (let d = 1; d <= 4; d++) await seedDay(testIp, d, 25);

    let blocked = await store.recordDenial(testIp, 25, 14, 5, DAY_MS);
    assert.strictEqual(blocked, false, 'today\'s single denial does not itself reach the daily threshold, and only 4 prior days qualify');

    // a 5th bad day pushes it over
    await seedDay(testIp, 5, 25);
    blocked = await store.recordDenial(testIp, 25, 14, 5, DAY_MS);
    assert.strictEqual(blocked, true);

    let resp = await db.query(`SELECT blocked_until FROM ${config.postgres.schema}.ip_block WHERE ip = $1`, [testIp]);
    assert.strictEqual(resp.rows.length, 1);
  });

  it('ignores threshold-exceeded days outside the trailing window', async () => {
    let testIp = ip();

    // 5 bad days, but all outside a 14-day window
    for (let d = 15; d <= 19; d++) await seedDay(testIp, d, 25);

    let blocked = await store.recordDenial(testIp, 25, 14, 5, DAY_MS);
    assert.strictEqual(blocked, false);

    let resp = await db.query(`SELECT * FROM ${config.postgres.schema}.ip_block WHERE ip = $1`, [testIp]);
    assert.strictEqual(resp.rows.length, 0);
  });

  it('never shortens an existing block - blocked_until only ever extends', async () => {
    let testIp = ip();
    for (let d = 1; d <= 5; d++) await seedDay(testIp, d, 25);

    // trigger a long (30 day) block
    await store.recordDenial(testIp, 25, 14, 5, 30 * DAY_MS);
    let first = (await db.query(`SELECT blocked_until FROM ${config.postgres.schema}.ip_block WHERE ip = $1`, [testIp])).rows[0].blocked_until;

    // a subsequent call with a much shorter block duration must not shrink it
    await store.recordDenial(testIp, 25, 14, 5, 1000);
    let second = (await db.query(`SELECT blocked_until FROM ${config.postgres.schema}.ip_block WHERE ip = $1`, [testIp])).rows[0].blocked_until;

    assert.strictEqual(second.getTime(), first.getTime(), 'blocked_until must not have been shortened');
  });

  it('isBlocked reflects whether blocked_until is in the future', async () => {
    let testIp = ip();

    assert.strictEqual(await store.isBlocked(testIp), null);

    await db.query(
      `INSERT INTO ${config.postgres.schema}.ip_block (ip, blocked_until) VALUES ($1, NOW() + interval '1 hour')`,
      [testIp]
    );
    assert.ok(await store.isBlocked(testIp));

    await db.query(`UPDATE ${config.postgres.schema}.ip_block SET blocked_until = NOW() - interval '1 second' WHERE ip = $1`, [testIp]);
    assert.strictEqual(await store.isBlocked(testIp), null);
  });

  it('pruneIpDenials removes old denial-count rows and long-expired blocks, leaving recent ones', async () => {
    let oldIp = ip();
    let recentIp = ip();
    let longExpiredIp = ip();
    let recentlyExpiredIp = ip();

    await seedDay(oldIp, 100, 5);
    await seedDay(recentIp, 1, 5);

    await db.query(`INSERT INTO ${config.postgres.schema}.ip_block (ip, blocked_until) VALUES ($1, NOW() - interval '100 days')`, [longExpiredIp]);
    await db.query(`INSERT INTO ${config.postgres.schema}.ip_block (ip, blocked_until) VALUES ($1, NOW() - interval '1 second')`, [recentlyExpiredIp]);

    let retentionMs = 14 * DAY_MS;
    let removed = await store.pruneIpDenials(retentionMs);
    assert.strictEqual(removed, 2);

    assert.strictEqual((await db.query(`SELECT * FROM ${config.postgres.schema}.ip_denial_count WHERE ip = $1`, [oldIp])).rows.length, 0);
    assert.strictEqual((await db.query(`SELECT * FROM ${config.postgres.schema}.ip_denial_count WHERE ip = $1`, [recentIp])).rows.length, 1);
    assert.strictEqual((await db.query(`SELECT * FROM ${config.postgres.schema}.ip_block WHERE ip = $1`, [longExpiredIp])).rows.length, 0);
    assert.strictEqual((await db.query(`SELECT * FROM ${config.postgres.schema}.ip_block WHERE ip = $1`, [recentlyExpiredIp])).rows.length, 1);
  });
});
