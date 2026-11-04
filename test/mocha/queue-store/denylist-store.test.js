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

  function group() {
    return 'test-group-' + crypto.randomUUID();
  }

  // defaults chosen so neither the ip-level nor the range-level block ever
  // triggers unless a test explicitly overrides the relevant threshold
  function denialOpts(overrides = {}) {
    return {
      ipGroup: group(),
      dailyThreshold: 1000,
      windowDays: 14,
      exceedThreshold: 1000,
      blockMs: DAY_MS,
      rangeThreshold: 100000,
      rangeBlockMs: DAY_MS,
      ...overrides
    };
  }

  // seed a historical ip_denial_count row directly, bypassing record_ip_denial,
  // so exceedance-day logic can be tested without needing real time to pass
  async function seedDay(testIp, daysAgo, count, ipGroup = group()) {
    await db.query(
      `INSERT INTO ${config.postgres.schema}.ip_denial_count (ip, ip_group, day, count)
       VALUES ($1, $2, (NOW() AT TIME ZONE 'UTC')::date - $3::int, $4)`,
      [testIp, ipGroup, daysAgo, count]
    );
  }

  it('recordDenial increments today\'s counter across repeated calls for the same ip', async () => {
    let testIp = ip();
    let opts = denialOpts();

    await store.recordDenial(testIp, opts);
    await store.recordDenial(testIp, opts);
    await store.recordDenial(testIp, opts);

    let resp = await db.query(
      `SELECT count FROM ${config.postgres.schema}.ip_denial_count WHERE ip = $1 AND day = (NOW() AT TIME ZONE 'UTC')::date`,
      [testIp]
    );
    assert.strictEqual(resp.rows[0].count, 3);
  });

  it('incrementDenialCount creates a new row with count=1 for a never-before-seen ip', async () => {
    let testIp = ip();
    let testGroup = group();

    await store.incrementDenialCount(testIp, testGroup);

    let resp = await db.query(
      `SELECT count, ip_group FROM ${config.postgres.schema}.ip_denial_count WHERE ip = $1 AND day = (NOW() AT TIME ZONE 'UTC')::date`,
      [testIp]
    );
    assert.strictEqual(resp.rows.length, 1);
    assert.strictEqual(resp.rows[0].count, 1);
    assert.strictEqual(resp.rows[0].ip_group, testGroup);
  });

  it('incrementDenialCount accumulates across repeated calls without ever touching ip_block or ip_group_block', async () => {
    let testIp = ip();
    let testGroup = group();

    await store.incrementDenialCount(testIp, testGroup);
    await store.incrementDenialCount(testIp, testGroup);
    await store.incrementDenialCount(testIp, testGroup);

    let countResp = await db.query(
      `SELECT count FROM ${config.postgres.schema}.ip_denial_count WHERE ip = $1 AND day = (NOW() AT TIME ZONE 'UTC')::date`,
      [testIp]
    );
    assert.strictEqual(countResp.rows[0].count, 3);

    let blockResp = await db.query(`SELECT * FROM ${config.postgres.schema}.ip_block WHERE ip = $1`, [testIp]);
    assert.strictEqual(blockResp.rows.length, 0, 'incrementDenialCount must never create an ip_block row, no matter how high the count climbs');

    let groupBlockResp = await db.query(`SELECT * FROM ${config.postgres.schema}.ip_group_block WHERE ip_group = $1`, [testGroup]);
    assert.strictEqual(groupBlockResp.rows.length, 0, 'incrementDenialCount must never create an ip_group_block row');
  });

  it('returns ipBlocked=false until enough threshold-exceeded days accumulate within the window, then true', async () => {
    let testIp = ip();
    let opts = denialOpts({ dailyThreshold: 25, windowDays: 14, exceedThreshold: 5, blockMs: DAY_MS });

    // 4 historical bad days - not yet enough to trigger a block at exceedThreshold=5
    for (let d = 1; d <= 4; d++) await seedDay(testIp, d, 25, opts.ipGroup);

    let { ipBlocked } = await store.recordDenial(testIp, opts);
    assert.strictEqual(ipBlocked, false, 'today\'s single denial does not itself reach the daily threshold, and only 4 prior days qualify');

    // a 5th bad day pushes it over
    await seedDay(testIp, 5, 25, opts.ipGroup);
    ({ ipBlocked } = await store.recordDenial(testIp, opts));
    assert.strictEqual(ipBlocked, true);

    let resp = await db.query(`SELECT blocked_until FROM ${config.postgres.schema}.ip_block WHERE ip = $1`, [testIp]);
    assert.strictEqual(resp.rows.length, 1);
  });

  it('ignores threshold-exceeded days outside the trailing window', async () => {
    let testIp = ip();
    let opts = denialOpts({ dailyThreshold: 25, windowDays: 14, exceedThreshold: 5, blockMs: DAY_MS });

    // 5 bad days, but all outside a 14-day window
    for (let d = 15; d <= 19; d++) await seedDay(testIp, d, 25, opts.ipGroup);

    let { ipBlocked } = await store.recordDenial(testIp, opts);
    assert.strictEqual(ipBlocked, false);

    let resp = await db.query(`SELECT * FROM ${config.postgres.schema}.ip_block WHERE ip = $1`, [testIp]);
    assert.strictEqual(resp.rows.length, 0);
  });

  it('never shortens an existing ip block - blocked_until only ever extends', async () => {
    let testIp = ip();
    let opts = denialOpts({ dailyThreshold: 25, windowDays: 14, exceedThreshold: 5 });
    for (let d = 1; d <= 5; d++) await seedDay(testIp, d, 25, opts.ipGroup);

    // trigger a long (30 day) block
    await store.recordDenial(testIp, { ...opts, blockMs: 30 * DAY_MS });
    let first = (await db.query(`SELECT blocked_until FROM ${config.postgres.schema}.ip_block WHERE ip = $1`, [testIp])).rows[0].blocked_until;

    // a subsequent call with a much shorter block duration must not shrink it
    await store.recordDenial(testIp, { ...opts, blockMs: 1000 });
    let second = (await db.query(`SELECT blocked_until FROM ${config.postgres.schema}.ip_block WHERE ip = $1`, [testIp])).rows[0].blocked_until;

    assert.strictEqual(second.getTime(), first.getTime(), 'blocked_until must not have been shortened');
  });

  it('isBlocked reflects whether ip\'s own blocked_until is in the future', async () => {
    let testIp = ip();
    let testGroup = group();

    assert.strictEqual(await store.isBlocked(testIp, testGroup), null);

    await db.query(
      `INSERT INTO ${config.postgres.schema}.ip_block (ip, blocked_until) VALUES ($1, NOW() + interval '1 hour')`,
      [testIp]
    );
    assert.ok(await store.isBlocked(testIp, testGroup));

    await db.query(`UPDATE ${config.postgres.schema}.ip_block SET blocked_until = NOW() - interval '1 second' WHERE ip = $1`, [testIp]);
    assert.strictEqual(await store.isBlocked(testIp, testGroup), null);
  });

  it('pruneIpDenials removes old denial-count rows and long-expired ip blocks, leaving recent ones', async () => {
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

  describe('range-level blocking', () => {

    it('blocks the whole range once more than rangeThreshold distinct ips are denied on the same day', async () => {
      let sharedGroup = group();
      let opts = denialOpts({ ipGroup: sharedGroup, rangeThreshold: 3, rangeBlockMs: DAY_MS });

      // 3 distinct ips - at the threshold, not yet over it
      for (let i = 0; i < 3; i++) {
        let { rangeBlocked } = await store.recordDenial(ip(), opts);
        assert.strictEqual(rangeBlocked, false);
      }

      // the 4th distinct ip pushes the group's today-count to 4, past rangeThreshold=3
      let { rangeBlocked } = await store.recordDenial(ip(), opts);
      assert.strictEqual(rangeBlocked, true);

      let resp = await db.query(`SELECT * FROM ${config.postgres.schema}.ip_group_block WHERE ip_group = $1`, [sharedGroup]);
      assert.strictEqual(resp.rows.length, 1);
    });

    it('does not block an unrelated range sharing no ips with the triggered one', async () => {
      let busyGroup = group();
      let quietGroup = group();
      let opts = denialOpts({ rangeThreshold: 3, rangeBlockMs: DAY_MS });

      for (let i = 0; i < 4; i++) await store.recordDenial(ip(), { ...opts, ipGroup: busyGroup });
      await store.recordDenial(ip(), { ...opts, ipGroup: quietGroup });

      let busy = await db.query(`SELECT * FROM ${config.postgres.schema}.ip_group_block WHERE ip_group = $1`, [busyGroup]);
      let quiet = await db.query(`SELECT * FROM ${config.postgres.schema}.ip_group_block WHERE ip_group = $1`, [quietGroup]);
      assert.strictEqual(busy.rows.length, 1);
      assert.strictEqual(quiet.rows.length, 0);
    });

    it('never shortens an existing range block - blocked_until only ever extends', async () => {
      let sharedGroup = group();
      let opts = denialOpts({ ipGroup: sharedGroup, rangeThreshold: 1 });

      await store.recordDenial(ip(), { ...opts, rangeBlockMs: 30 * DAY_MS });
      await store.recordDenial(ip(), { ...opts, rangeBlockMs: 30 * DAY_MS });
      let first = (await db.query(`SELECT blocked_until FROM ${config.postgres.schema}.ip_group_block WHERE ip_group = $1`, [sharedGroup])).rows[0].blocked_until;

      await store.recordDenial(ip(), { ...opts, rangeBlockMs: 1000 });
      let second = (await db.query(`SELECT blocked_until FROM ${config.postgres.schema}.ip_group_block WHERE ip_group = $1`, [sharedGroup])).rows[0].blocked_until;

      assert.strictEqual(second.getTime(), first.getTime(), 'blocked_until must not have been shortened');
    });

    it('isBlocked reflects whether the range\'s blocked_until is in the future', async () => {
      let testIp = ip();
      let testGroup = group();

      assert.strictEqual(await store.isBlocked(testIp, testGroup), null);

      await db.query(
        `INSERT INTO ${config.postgres.schema}.ip_group_block (ip_group, blocked_until) VALUES ($1, NOW() + interval '1 hour')`,
        [testGroup]
      );
      assert.ok(await store.isBlocked(testIp, testGroup));

      await db.query(`UPDATE ${config.postgres.schema}.ip_group_block SET blocked_until = NOW() - interval '1 second' WHERE ip_group = $1`, [testGroup]);
      assert.strictEqual(await store.isBlocked(testIp, testGroup), null);
    });

    it('pruneIpDenials also removes long-expired range blocks, leaving recent ones', async () => {
      let longExpiredGroup = group();
      let recentlyExpiredGroup = group();

      await db.query(`INSERT INTO ${config.postgres.schema}.ip_group_block (ip_group, blocked_until) VALUES ($1, NOW() - interval '100 days')`, [longExpiredGroup]);
      await db.query(`INSERT INTO ${config.postgres.schema}.ip_group_block (ip_group, blocked_until) VALUES ($1, NOW() - interval '1 second')`, [recentlyExpiredGroup]);

      let removed = await store.pruneIpDenials(14 * DAY_MS);
      assert.strictEqual(removed, 1);

      assert.strictEqual((await db.query(`SELECT * FROM ${config.postgres.schema}.ip_group_block WHERE ip_group = $1`, [longExpiredGroup])).rows.length, 0);
      assert.strictEqual((await db.query(`SELECT * FROM ${config.postgres.schema}.ip_group_block WHERE ip_group = $1`, [recentlyExpiredGroup])).rows.length, 1);
    });
  });
});
