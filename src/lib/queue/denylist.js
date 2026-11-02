import { getClientIp as resolveClientIp } from './ip-group.js';

/**
 * @class Denylist
 * @description IP-level denial tracking and escalating blocking, reacting
 * to 429s issued by the queue's concurrency admission gate. Tracks raw
 * per-ip (not CIDR-grouped) denial counts bucketed by UTC calendar day;
 * once an ip accumulates enough threshold-exceeded days within a trailing
 * window, it is blocked entirely for a configurable duration. Independent
 * of - and runs before - the cache and queue gates. State is coordinated
 * across service instances via Postgres (see ./denylist-store.js); any
 * Postgres error fails the gate open (never blocks a request due to an
 * internal error). Requests from a client ip on the configured allowlist
 * bypass this gate entirely, for consistency with the queue gate's own
 * allowlist bypass.
 */
class Denylist {

  /**
   * @param {Object} opts
   * @param {Object} opts.config denylist settings: dailyThreshold,
   * windowDays, exceedThreshold, blockMs, sweepIntervalMs,
   * pruneRetentionMs, clientIpHeader
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
   * @description check whether ip is currently blocked. Allowlisted ips
   * are never blocked. Fails open (treats as not blocked) on a Postgres
   * error, consistent with the rest of the gateway's gates.
   *
   * @param {String} ip raw client ip address
   * @returns {Promise<Number|null>} seconds remaining until unblocked (min
   * 1), or null if not currently blocked
   */
  async isBlocked(ip) {
    if (this.allowlist.isAllowed(ip)) return null;
    try {
      let blockedUntil = await this.store.isBlocked(ip);
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
   * @description record one queue-issued 429 against ip. Intended to be
   * called fire-and-forget (not awaited on the response path) immediately
   * after Queue.admit() sends a 429. Never rejects - any Postgres error is
   * logged and swallowed internally, so callers do not need their own
   * .catch(). Allowlisted ips are skipped (belt-and-suspenders: the queue
   * itself never 429s an allowlisted ip today, since Queue.isInScope()
   * already bypasses it, but this keeps the two gates' allowlist behavior
   * symmetric even if that ever changes).
   *
   * @param {String} ip raw client ip address
   * @returns {Promise<void>}
   */
  async recordDenial(ip) {
    if (this.allowlist.isAllowed(ip)) return;
    try {
      let cfg = this.config;
      let blocked = await this.store.recordDenial(ip, cfg.dailyThreshold, cfg.windowDays, cfg.exceedThreshold, cfg.blockMs);
      if (blocked) {
        this.logger.warn(`denylist: ip ${ip} blocked (or block extended) after reaching ${cfg.exceedThreshold} threshold-exceeded day(s) within a ${cfg.windowDays}d window`);
      }
    } catch (e) {
      this.logger.error('denylist: postgres error on recordDenial', e);
    }
  }
}

export { Denylist };
