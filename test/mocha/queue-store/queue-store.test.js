import assert from 'assert';
import crypto from 'crypto';
import config from '../../../src/lib/config.js';
import { Db } from '../../../src/lib/db/pool.js';
import { QueueStore } from '../../../src/lib/queue/store.js';
import { resetQueueSchema } from '../queue-test-helpers.js';

describe('QueueStore (Postgres)', function () {
  this.timeout(20000);

  let db, store;

  before(async () => {
    db = new Db({ postgres: config.postgres });
    store = new QueueStore({ db, schema: config.postgres.schema });
  });

  beforeEach(async () => {
    await resetQueueSchema(db, config.postgres.schema);
  });

  after(async () => {
    await db.end();
  });

  function id() {
    return crypto.randomUUID();
  }

  it('try_admit caps concurrent admission at maxServed under real concurrency', async () => {
    let group = 'test-group-' + id();
    let ids = Array.from({ length: 5 }, () => id());

    let results = await Promise.all(ids.map(requestId => store.tryAdmit(requestId, group, 3)));
    let admittedCount = results.filter(Boolean).length;

    assert.strictEqual(admittedCount, 3, 'exactly max_served requests should be admitted');
  });

  it('enqueue_if_room caps the pending queue at maxPending under real concurrency', async () => {
    let group = 'test-group-' + id();
    let ids = Array.from({ length: 5 }, () => id());

    let results = await Promise.all(ids.map(requestId => store.enqueueIfRoom(requestId, group, 2)));
    let enqueuedCount = results.filter(Boolean).length;

    assert.strictEqual(enqueuedCount, 2, 'exactly max_pending requests should be enqueued');
  });

  it('release_and_promote promotes pending requests in FIFO order', async () => {
    let group = 'test-group-' + id();
    let active = id();
    await store.tryAdmit(active, group, 1);

    // sequential, to guarantee "created" ordering
    let first = id();
    let second = id();
    let third = id();
    assert.strictEqual(await store.enqueueIfRoom(first, group, 3), true);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.strictEqual(await store.enqueueIfRoom(second, group, 3), true);
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.strictEqual(await store.enqueueIfRoom(third, group, 3), true);

    let promoted1 = await store.releaseAndPromote(active, group);
    assert.strictEqual(promoted1, first);

    let promoted2 = await store.releaseAndPromote(first, group);
    assert.strictEqual(promoted2, second);

    let promoted3 = await store.releaseAndPromote(second, group);
    assert.strictEqual(promoted3, third);

    let promoted4 = await store.releaseAndPromote(third, group);
    assert.strictEqual(promoted4, null, 'no one left to promote');
  });

  it('release_and_promote does not double-decrement active_count when its own row was already removed', async () => {
    let group = 'test-group-' + id();
    let requestA = id();
    let requestB = id();

    // two legitimately active requests sharing this group
    assert.strictEqual(await store.tryAdmit(requestA, group, 2), true);
    assert.strictEqual(await store.tryAdmit(requestB, group, 2), true);

    // simulate a concurrent reconcile_stale having already removed
    // requestA's row and correctly recomputed active_count down to 1
    // (requestB is still genuinely active) before requestA's own
    // (redundant, e.g. slow/duplicate) release_and_promote call arrives
    await db.query(`DELETE FROM ${config.postgres.schema}.active_request WHERE request_id = $1`, [requestA]);
    await db.query(`UPDATE ${config.postgres.schema}.group_state SET active_count = 1 WHERE ip_group = $1`, [group]);

    await store.releaseAndPromote(requestA, group);

    let resp = await db.query(`SELECT active_count FROM ${config.postgres.schema}.group_state WHERE ip_group = $1`, [group]);
    assert.strictEqual(resp.rows[0].active_count, 1, 'the redundant release must not decrement a slot that is still genuinely held by requestB');
    assert.strictEqual(await store.isActive(requestB), true);

    // requestB's slot should still count against the cap: with a cap of 1,
    // a third request must not be let in (if active_count had wrongly been
    // decremented to 0, this would incorrectly succeed)
    assert.strictEqual(await store.tryAdmit(id(), group, 1), false);
  });

  it('expire_pending returns false when the row was already promoted by a concurrent release', async () => {
    let group = 'test-group-' + id();
    let active = id();
    let waiting = id();

    await store.tryAdmit(active, group, 1);
    await store.enqueueIfRoom(waiting, group, 1);

    // free the one active slot, promoting "waiting" into it
    let promoted = await store.releaseAndPromote(active, group);
    assert.strictEqual(promoted, waiting);

    // now try to expire "waiting" as if it were still pending - it's not anymore
    let removed = await store.expirePending(waiting, group);
    assert.strictEqual(removed, false);
    assert.strictEqual(await store.isActive(waiting), true, 'it should have landed in active instead');
  });

  it('reconcile_stale removes abandoned active rows and recomputes active_count', async () => {
    let group = 'test-group-' + id();
    let staleId = id();
    let freshId = id();

    await store.tryAdmit(staleId, group, 2);
    await store.tryAdmit(freshId, group, 2);

    // backdate the "stale" row directly
    await db.query(
      `UPDATE ${config.postgres.schema}.active_request SET created = NOW() - interval '1 hour' WHERE request_id = $1`,
      [staleId]
    );

    let removed = await store.reconcileStale(60000);
    assert.strictEqual(removed, 1);
    assert.strictEqual(await store.isActive(staleId), false);
    assert.strictEqual(await store.isActive(freshId), true);

    let resp = await db.query(`SELECT active_count FROM ${config.postgres.schema}.group_state WHERE ip_group = $1`, [group]);
    assert.strictEqual(resp.rows[0].active_count, 1);
  });

  it('isActive reflects admission and release transitions', async () => {
    let group = 'test-group-' + id();
    let requestId = id();

    assert.strictEqual(await store.isActive(requestId), false);
    await store.tryAdmit(requestId, group, 1);
    assert.strictEqual(await store.isActive(requestId), true);
    await store.releaseAndPromote(requestId, group);
    assert.strictEqual(await store.isActive(requestId), false);
  });

  it('pruneIdleGroups removes a fully idle group_state row past the idle window', async () => {
    let group = 'test-group-' + id();
    let requestId = id();

    await store.tryAdmit(requestId, group, 1);
    await store.releaseAndPromote(requestId, group);

    await db.query(
      `UPDATE ${config.postgres.schema}.group_state SET last_active = NOW() - interval '1 hour' WHERE ip_group = $1`,
      [group]
    );

    let removed = await store.pruneIdleGroups(60000);
    assert.strictEqual(removed, 1);

    let resp = await db.query(`SELECT * FROM ${config.postgres.schema}.group_state WHERE ip_group = $1`, [group]);
    assert.strictEqual(resp.rows.length, 0);
  });

  it('pruneIdleGroups leaves rows with nonzero counts or recent activity alone', async () => {
    let idleGroup = 'test-group-' + id();
    let busyGroup = 'test-group-' + id();
    let recentGroup = 'test-group-' + id();

    // idle but not past the window yet
    let recentId = id();
    await store.tryAdmit(recentId, recentGroup, 1);
    await store.releaseAndPromote(recentId, recentGroup);

    // still has an active request, so counts are nonzero
    await store.tryAdmit(id(), busyGroup, 1);

    // genuinely idle and old enough to prune, used as a control
    let idleId = id();
    await store.tryAdmit(idleId, idleGroup, 1);
    await store.releaseAndPromote(idleId, idleGroup);
    await db.query(
      `UPDATE ${config.postgres.schema}.group_state SET last_active = NOW() - interval '1 hour' WHERE ip_group = $1`,
      [idleGroup]
    );

    let removed = await store.pruneIdleGroups(60000);
    assert.strictEqual(removed, 1);

    assert.strictEqual((await db.query(`SELECT * FROM ${config.postgres.schema}.group_state WHERE ip_group = $1`, [recentGroup])).rows.length, 1);
    assert.strictEqual((await db.query(`SELECT * FROM ${config.postgres.schema}.group_state WHERE ip_group = $1`, [busyGroup])).rows.length, 1);
    assert.strictEqual((await db.query(`SELECT * FROM ${config.postgres.schema}.group_state WHERE ip_group = $1`, [idleGroup])).rows.length, 0);
  });

  it('tryAdmit still admits correctly when racing a concurrent prune of its own just-emptied group', async () => {
    let group = 'test-group-' + id();
    let first = id();

    // make the group exist, then go idle and old enough to be prune-eligible
    await store.tryAdmit(first, group, 1);
    await store.releaseAndPromote(first, group);
    await db.query(
      `UPDATE ${config.postgres.schema}.group_state SET last_active = NOW() - interval '1 hour' WHERE ip_group = $1`,
      [group]
    );

    // race a prune against a fresh admission for the same group; regardless
    // of ordering, the admission must succeed exactly once (the retry-loop
    // in try_admit guards against the row disappearing mid-function)
    let second = id();
    let [, admitted] = await Promise.all([
      store.pruneIdleGroups(60000),
      store.tryAdmit(second, group, 1)
    ]);

    assert.strictEqual(admitted, true, 'tryAdmit must not be defeated by a concurrent prune of its own group');
    assert.strictEqual(await store.isActive(second), true);
  });
});
