/**
 * @function resetQueueSchema
 * @description truncate the queue's state tables between tests, so each test
 * starts from an empty queue regardless of what earlier tests left behind.
 *
 * @param {Db} db a Db instance pointed at the shared test Postgres instance
 * @param {String} schema queue schema name
 * @returns {Promise<void>}
 */
async function resetQueueSchema(db, schema) {
  await db.query(`TRUNCATE ${schema}.group_state, ${schema}.active_request, ${schema}.pending_request`);
}

/**
 * @function resetDenylistSchema
 * @description truncate the denylist's state tables between tests, so each
 * test starts with no recorded denials or blocks regardless of what earlier
 * tests left behind.
 *
 * @param {Db} db a Db instance pointed at the shared test Postgres instance
 * @param {String} schema queue schema name
 * @returns {Promise<void>}
 */
async function resetDenylistSchema(db, schema) {
  await db.query(`TRUNCATE ${schema}.ip_denial_count, ${schema}.ip_block`);
}

export { resetQueueSchema, resetDenylistSchema };
