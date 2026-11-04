/**
 * @class DenylistStore
 * @description Postgres access layer for per-ip denial tracking and
 * escalating blocks, reacting to 429s issued either by the queue's
 * concurrency gate (see ../queue/index.js) or by the denylist's own
 * pre-check (see incrementDenialCount). Every method is a single round
 * trip; see sql/002-queue-denylist.sql for the underlying tables/functions.
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
   * @description record one denial for ip (a member of opts.ipGroup)
   * against today's (UTC) counters, and escalate to a (possibly extended)
   * ip-level block if ip has now accumulated opts.exceedThreshold or more
   * threshold-exceeded days within the trailing opts.windowDays; separately,
   * escalate to a (possibly extended) range-level block if more than
   * opts.rangeThreshold distinct ips out of opts.ipGroup were denied today.
   *
   * @param {String} ip raw client ip address
   * @param {Object} opts
   * @param {String} opts.ipGroup CIDR-masked group key for ip, see
   * ./ip-group.js's toGroupKey
   * @param {Number} opts.dailyThreshold denials/day that counts as a
   * "threshold-exceeded day" for the ip-level block
   * @param {Number} opts.windowDays trailing window size, in UTC calendar
   * days (inclusive of today), for the ip-level block
   * @param {Number} opts.exceedThreshold number of threshold-exceeded days
   * within the window that triggers an ip-level block
   * @param {Number} opts.blockMs ip-level block duration in milliseconds,
   * applied from now (only ever extends an existing block, never shortens it)
   * @param {Number} opts.rangeThreshold distinct denied ips/day within
   * opts.ipGroup that triggers a range-level block
   * @param {Number} opts.rangeBlockMs range-level block duration in
   * milliseconds, applied from now (only ever extends, never shortens)
   * @returns {Promise<Object>} {ipBlocked, rangeBlocked} - whether each
   * block type is in effect as a result of this call
   */
  async recordDenial(ip, opts) {
    let resp = await this.db.query(
      `SELECT * FROM ${this.schema}.record_ip_denial($1, $2, $3, $4, $5, $6, $7, $8)`,
      [ip, opts.ipGroup, opts.dailyThreshold, opts.windowDays, opts.exceedThreshold, opts.blockMs, opts.rangeThreshold, opts.rangeBlockMs]
    );
    let row = resp.rows[0];
    return { ipBlocked: row.ip_blocked, rangeBlocked: row.range_blocked };
  }

  /**
   * @method incrementDenialCount
   * @description record one denial for ip (a member of ipGroup) against
   * today's (UTC) counter only - the same ip_denial_count upsert
   * record_ip_denial performs as its first step, but with none of that
   * function's window-evaluation or ip_block/ip_group_block escalation.
   * Intended for a request that Denylist.isBlocked() already rejected
   * before it ever reached the queue - see Denylist.recordBlockedRequest
   * for why escalation must be skipped on that path. A plain inline upsert
   * (not a stored function), for the same reason isBlocked() isn't one: a
   * single-statement write, no multi-step logic worth encapsulating
   * server-side.
   *
   * @param {String} ip raw client ip address
   * @param {String} ipGroup CIDR-masked group key for ip, see
   * ./ip-group.js's toGroupKey
   * @returns {Promise<void>}
   */
  async incrementDenialCount(ip, ipGroup) {
    await this.db.query(
      `INSERT INTO ${this.schema}.ip_denial_count (ip, ip_group, day, count)
       VALUES ($1, $2, (NOW() AT TIME ZONE 'UTC')::date, 1)
       ON CONFLICT (ip, day) DO UPDATE SET count = ip_denial_count.count + 1, ip_group = EXCLUDED.ip_group`,
      [ip, ipGroup]
    );
  }

  /**
   * @method isBlocked
   * @description check whether ip or its range (ipGroup) is currently
   * blocked. A plain indexed lookup across both block tables in a single
   * round trip, rather than a stored function - this runs on every single
   * request while the gate is enabled and has no multi-step logic worth
   * encapsulating server-side.
   *
   * @param {String} ip raw client ip address
   * @param {String} ipGroup CIDR-masked group key for ip, see
   * ./ip-group.js's toGroupKey
   * @returns {Promise<Date|null>} the later of the two blocked_until values
   * if either is currently blocked, else null
   */
  async isBlocked(ip, ipGroup) {
    let resp = await this.db.query(
      `SELECT blocked_until FROM ${this.schema}.ip_block WHERE ip = $1 AND blocked_until > NOW()
       UNION ALL
       SELECT blocked_until FROM ${this.schema}.ip_group_block WHERE ip_group = $2 AND blocked_until > NOW()
       ORDER BY blocked_until DESC LIMIT 1`,
      [ip, ipGroup]
    );
    return resp.rows.length ? resp.rows[0].blocked_until : null;
  }

  /**
   * @method pruneIpDenials
   * @description delete ip_denial_count rows older than the trailing
   * window and long-expired ip_block/ip_group_block rows, keeping all
   * three tables bounded.
   *
   * @param {Number} retentionMs age in milliseconds past which a row is
   * considered safe to delete (see sql/002-queue-denylist.sql for exact semantics)
   * @returns {Promise<Number>} total number of rows removed across all tables
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
