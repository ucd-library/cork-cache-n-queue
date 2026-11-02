/**
 * @class DenylistStore
 * @description Postgres access layer for per-ip denial tracking and
 * escalating blocks, reacting to 429s issued by the queue's concurrency
 * gate (see ../queue/index.js). Every method is a single round trip; see
 * sql/002-queue-denylist.sql for the underlying tables/functions.
 */
class DenylistStore {

  /**
   * @param {Object} opts
   * @param {Object} opts.db a Db instance (see ../db/pool.js)
   * @param {String} opts.schema Postgres schema the denylist functions live in
   */
  constructor(opts = {}) {
    this.db = opts.db;
    this.schema = opts.schema;
  }

  /**
   * @method recordDenial
   * @description record one denial for ip against today's (UTC) counter,
   * and escalate to a (possibly extended) block if ip has now accumulated
   * exceedThreshold or more threshold-exceeded days within the trailing
   * windowDays.
   *
   * @param {String} ip raw client ip address
   * @param {Number} dailyThreshold denials/day that counts as a
   * "threshold-exceeded day"
   * @param {Number} windowDays trailing window size, in UTC calendar days
   * (inclusive of today)
   * @param {Number} exceedThreshold number of threshold-exceeded days
   * within the window that triggers a block
   * @param {Number} blockMs block duration in milliseconds, applied from
   * now (only ever extends an existing block, never shortens it)
   * @returns {Promise<Boolean>} true if a block is in effect as a result
   * of this call
   */
  async recordDenial(ip, dailyThreshold, windowDays, exceedThreshold, blockMs) {
    let resp = await this.db.query(
      `SELECT ${this.schema}.record_ip_denial($1, $2, $3, $4, $5) AS blocked`,
      [ip, dailyThreshold, windowDays, exceedThreshold, blockMs]
    );
    return resp.rows[0].blocked;
  }

  /**
   * @method isBlocked
   * @description check whether ip is currently blocked. A plain indexed
   * primary-key lookup rather than a stored function - this runs on every
   * single request while the gate is enabled and has no multi-step logic
   * worth encapsulating server-side.
   *
   * @param {String} ip raw client ip address
   * @returns {Promise<Date|null>} blocked_until if currently blocked, else null
   */
  async isBlocked(ip) {
    let resp = await this.db.query(
      `SELECT blocked_until FROM ${this.schema}.ip_block WHERE ip = $1 AND blocked_until > NOW()`,
      [ip]
    );
    return resp.rows.length ? resp.rows[0].blocked_until : null;
  }

  /**
   * @method pruneIpDenials
   * @description delete ip_denial_count rows older than the trailing
   * window and long-expired ip_block rows, keeping both tables bounded.
   *
   * @param {Number} retentionMs age in milliseconds past which a row is
   * considered safe to delete (see sql/002-queue-denylist.sql for exact semantics)
   * @returns {Promise<Number>} total number of rows removed across both tables
   */
  async pruneIpDenials(retentionMs) {
    let resp = await this.db.query(
      `SELECT ${this.schema}.prune_ip_denials($1) AS removed`,
      [retentionMs]
    );
    return resp.rows[0].removed;
  }
}

export { DenylistStore };
