/**
 * @class QueueStore
 * @description Postgres access layer for the queue's per-ip-group admission
 * and wait-queue state. Every method is a single round trip to a stored
 * function, so these are safe to call against a shared connection pool and
 * remain correct across concurrent service replicas - each stored function
 * locks the relevant group_state row before mutating anything, so two
 * instances acting on the same ip group always serialize through Postgres
 * itself.
 */
class QueueStore {

  /**
   * @param {Object} opts
   * @param {Object} opts.db a Db instance (see ../db/pool.js)
   * @param {String} opts.schema Postgres schema the queue functions live in
   */
  constructor(opts = {}) {
    this.db = opts.db;
    this.schema = opts.schema;
  }

  /**
   * @method tryAdmit
   * @description attempt to claim an in-flight (active) slot for the given
   * ip group, atomically capped at maxServed.
   *
   * @param {String} requestId unique id for this request
   * @param {String} group ip group key
   * @param {Number} maxServed max concurrent in-flight requests allowed per group
   * @returns {Promise<Boolean>} true if a slot was claimed
   */
  async tryAdmit(requestId, group, maxServed) {
    let resp = await this.db.query(
      `SELECT ${this.schema}.try_admit($1, $2, $3) AS admitted`,
      [requestId, group, maxServed]
    );
    return resp.rows[0].admitted;
  }

  /**
   * @method enqueueIfRoom
   * @description insert a pending (queued) row for the given ip group if
   * current pending count is below maxPending.
   *
   * @param {String} requestId unique id for this request
   * @param {String} group ip group key
   * @param {Number} maxPending max queued requests allowed per group
   * @returns {Promise<Boolean>} true if enqueued, false if the queue is full
   */
  async enqueueIfRoom(requestId, group, maxPending) {
    let resp = await this.db.query(
      `SELECT ${this.schema}.enqueue_if_room($1, $2, $3) AS enqueued`,
      [requestId, group, maxPending]
    );
    return resp.rows[0].enqueued;
  }

  /**
   * @method isActive
   * @description check whether a request has been promoted to (or directly
   * admitted into) the active set.
   *
   * @param {String} requestId unique id for this request
   * @returns {Promise<Boolean>}
   */
  async isActive(requestId) {
    let resp = await this.db.query(
      `SELECT 1 FROM ${this.schema}.active_request WHERE request_id = $1`,
      [requestId]
    );
    return resp.rows.length > 0;
  }

  /**
   * @method releaseAndPromote
   * @description release an active slot for the given ip group and, if a
   * pending request is waiting for that group, promote the oldest one into
   * the now-free slot.
   *
   * @param {String} requestId unique id of the completing request
   * @param {String} group ip group key
   * @returns {Promise<String|null>} the promoted request id, or null if no one was waiting
   */
  async releaseAndPromote(requestId, group) {
    let resp = await this.db.query(
      `SELECT ${this.schema}.release_and_promote($1, $2) AS promoted_id`,
      [requestId, group]
    );
    return resp.rows[0].promoted_id;
  }

  /**
   * @method expirePending
   * @description remove a pending row, used both when a queued request times
   * out and when a queued client disconnects early.
   *
   * @param {String} requestId unique id for this request
   * @param {String} group ip group key
   * @returns {Promise<Boolean>} true if a pending row was removed; false
   * means it was already promoted to active (or already removed) by someone
   * else, so the caller should re-check isActive before giving up on it
   */
  async expirePending(requestId, group) {
    let resp = await this.db.query(
      `SELECT ${this.schema}.expire_pending($1, $2) AS removed`,
      [requestId, group]
    );
    return resp.rows[0].removed;
  }

  /**
   * @method reconcileStale
   * @description crash-recovery safety net: delete active rows older than
   * staleMs and recompute active_count from what actually remains. Intended
   * to be called opportunistically (not on a timer) from the one path where
   * a phantom stale slot would actually block a real request.
   *
   * @param {Number} staleMs age in milliseconds after which an active row is considered abandoned
   * @returns {Promise<Number>} number of stale rows removed
   */
  async reconcileStale(staleMs) {
    let resp = await this.db.query(
      `SELECT ${this.schema}.reconcile_stale($1) AS removed`,
      [staleMs]
    );
    return resp.rows[0].removed;
  }

  /**
   * @method pruneIdleGroups
   * @description delete group_state rows that have had zero active and zero
   * pending requests for at least idleMs, keeping the table from growing
   * unbounded as new ip groups are seen over time.
   *
   * @param {Number} idleMs idle duration in milliseconds after which a fully
   * idle group's row is removed
   * @returns {Promise<Number>} number of rows removed
   */
  async pruneIdleGroups(idleMs) {
    let resp = await this.db.query(
      `SELECT ${this.schema}.prune_idle_groups($1) AS removed`,
      [idleMs]
    );
    return resp.rows[0].removed;
  }
}

export { QueueStore };
