import { getClientIp as resolveClientIp, toGroupKey } from './ip-group.js';

/**
 * @class Denylist
 * @description Two-tier denial tracking and escalating blocking, reacting
 * to 429s issued by the queue's concurrency admission gate. Also counts -
 * without re-evaluating escalation - requests that this gate's own
 * pre-check (isBlocked) rejects, via recordBlockedRequest, so an ip's (or
 * its range's) denial history stays accurate for the next real escalation
 * decision even while already blocked. Tracks raw per-ip denial counts
 * bucketed by UTC calendar day; once an ip accumulates
 * enough threshold-exceeded days within a trailing window, it is blocked
 * entirely for a configurable duration. Independently, if more than
 * rangeThreshold distinct ips out of the same CIDR-masked range (the same
 * grouping concept the queue uses for concurrency, see ./ip-group.js) are
 * denied on the same UTC day, the entire range is blocked for a flat
 * rangeBlockMs (no escalation). Independent of - and runs before - the
 * cache and queue gates. State is coordinated across service instances via
 * Postgres (see ./denylist-store.js); any Postgres error fails the gate
 * open (never blocks a request due to an internal error). Requests from a
 * client ip on the configured allowlist bypass this gate entirely, for
 * consistency with the queue gate's own allowlist bypass.
 */
class Denylist {

  /**
   * @param {Object} opts
   * @param {Object} opts.config denylist settings: dailyThreshold,
   * windowDays, exceedThreshold, blockMs, rangeIpThreshold, rangeBlockMs,
   * ipv4PrefixLength, ipv6PrefixLength, sweepIntervalMs, pruneRetentionMs,
   * clientIpHeader
   * @param {DenylistStore} opts.store Postgres-backed denylist store
   * @param {Object} opts.allowlist {isAllowed(ip)}, see ./allowlist.js
   * @param {Object} opts.logger logger instance
   */
  constructor(opts = {}) {
    this.config = opts.config;
    this.store = opts.store;
    this.allowlist = opts.allowlist;
    this.logger = opts.logger;
    this._sweepTimer = null;
  }

  /**
   * @method getClientIp
   * @description resolve the raw client ip for a request, using the
   * configured trusted header. Reused both for the pre-gate block check and
   * for recording a denial after a queue 429.
   *
   * @param {Object} req express request object
   * @returns {String} raw client ip address (not CIDR-masked)
   */
  getClientIp(req) {
    return resolveClientIp(req, { trustedHeader: this.config.clientIpHeader });
  }

  /**
   * @method getIpGroup
   * @description mask a raw client ip to its CIDR range key, using the same
   * prefix lengths the queue uses for concurrency grouping (so "range"
   * means the same thing everywhere in the service).
   *
   * @param {String} ip raw client ip address
   * @returns {String} CIDR-masked group key, e.g. "v4:198.51.100.0/24"
   */
  getIpGroup(ip) {
    return toGroupKey(ip, { v4PrefixLength: this.config.ipv4PrefixLength, v6PrefixLength: this.config.ipv6PrefixLength });
  }

  /**
   * @method startSweeping
   * @description start the background timer that prunes old
   * ip_denial_count rows and long-expired ip_block rows. Safe to call more
   * than once; only one timer is ever active.
   *
   * @returns {void}
   */
  startSweeping() {
    if (this._sweepTimer) return;
    this._sweepTimer = setInterval(() => this._sweep(), this.config.sweepIntervalMs);
    this._sweepTimer.unref();
  }

  /**
   * @method stopSweeping
   * @description stop the background sweep timer, if running.
   *
   * @returns {void}
   */
  stopSweeping() {
    if (!this._sweepTimer) return;
    clearInterval(this._sweepTimer);
    this._sweepTimer = null;
  }

  /**
   * @method _sweep
   * @description one scheduled sweep tick: prune stale denial-count/block
   * rows. Try/caught so a failure here never affects request handling.
   *
   * @returns {Promise<void>}
   */
  async _sweep() {
    try {
      await this.store.pruneIpDenials(this.config.pruneRetentionMs);
    } catch (e) {
      this.logger.error('denylist: postgres error on scheduled pruneIpDenials', e);
    }
  }

  /**
   * @method isBlocked
   * @description check whether ip, or its range, is currently blocked.
   * Allowlisted ips are never blocked. Fails open (treats as not blocked)
   * on a Postgres error, consistent with the rest of the gateway's gates.
   *
   * @param {String} ip raw client ip address
   * @returns {Promise<Number|null>} seconds remaining until unblocked (min
   * 1), or null if not currently blocked
   */
  async isBlocked(ip) {
    if (this.allowlist.isAllowed(ip)) return null;
    try {
      let blockedUntil = await this.store.isBlocked(ip, this.getIpGroup(ip));
      if (!blockedUntil) return null;
      let remainingMs = new Date(blockedUntil).getTime() - Date.now();
      return Math.max(Math.ceil(remainingMs / 1000), 1);
    } catch (e) {
      this.logger.error('denylist: postgres error on isBlocked, failing open', e);
      return null;
    }
  }

  /**
   * @method recordDenial
   * @description record one queue-issued 429 against ip (and its range).
   * Intended to be called fire-and-forget (not awaited on the response
   * path) immediately after Queue.admit() sends a 429. Never rejects - any
   * Postgres error is logged and swallowed internally, so callers do not
   * need their own .catch(). Allowlisted ips are skipped (belt-and-
   * suspenders: the queue itself never 429s an allowlisted ip today, since
   * Queue.isInScope() already bypasses it, but this keeps the two gates'
   * allowlist behavior symmetric even if that ever changes).
   *
   * @param {String} ip raw client ip address
   * @returns {Promise<void>}
   */
  async recordDenial(ip) {
    if (this.allowlist.isAllowed(ip)) return;
    try {
      let cfg = this.config;
      let ipGroup = this.getIpGroup(ip);
      let { ipBlocked, rangeBlocked } = await this.store.recordDenial(ip, {
        ipGroup,
        dailyThreshold: cfg.dailyThreshold,
        windowDays: cfg.windowDays,
        exceedThreshold: cfg.exceedThreshold,
        blockMs: cfg.blockMs,
        rangeThreshold: cfg.rangeIpThreshold,
        rangeBlockMs: cfg.rangeBlockMs
      });
      if (ipBlocked) {
        this.logger.warn(`denylist: ip ${ip} blocked (or block extended) after reaching ${cfg.exceedThreshold} threshold-exceeded day(s) within a ${cfg.windowDays}d window`);
      }
      if (rangeBlocked) {
        this.logger.warn(`denylist: range ${ipGroup} blocked (or block extended) after more than ${cfg.rangeIpThreshold} distinct ips were denied today`);
      }
    } catch (e) {
      this.logger.error('denylist: postgres error on recordDenial', e);
    }
  }

  /**
   * @method recordBlockedRequest
   * @description record one denial against ip's raw per-day counter only,
   * for a request that isBlocked() itself rejected (ip, or its range, was
   * already blocked before the request ever reached the queue). Narrower
   * than recordDenial() on purpose: it never evaluates or re-upserts
   * ip_block/ip_group_block escalation, only
   * DenylistStore.incrementDenialCount()'s raw counter write. This keeps an
   * already-blocked ip's own window history accurate - so the next real
   * escalation decision (whenever recordDenial() next runs for it) sees the
   * full picture - without the risk recordDenial() would carry here: a
   * continually-retried, already-blocked ip would keep re-satisfying its
   * own exceedThreshold check on essentially every request, and
   * GREATEST(existing blocked_until, now + blockMs) would then almost
   * always pick the new, later value - turning a fixed-duration block into
   * a de facto indefinite one for as long as the client keeps retrying.
   * Intended to be called fire-and-forget (not awaited on the response
   * path), immediately after isBlocked() returns non-null. Never rejects -
   * any Postgres error is logged and swallowed internally, so callers do
   * not need their own .catch(). Allowlisted ips are skipped (isBlocked()
   * never returns non-null for one, so this is belt-and-suspenders only,
   * matching recordDenial()'s own rationale for the same check).
   *
   * @param {String} ip raw client ip address
   * @returns {Promise<void>}
   */
  async recordBlockedRequest(ip) {
    if (this.allowlist.isAllowed(ip)) return;
    try {
      await this.store.incrementDenialCount(ip, this.getIpGroup(ip));
    } catch (e) {
      this.logger.error('denylist: postgres error on recordBlockedRequest', e);
    }
  }
}

export { Denylist };
