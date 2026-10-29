import crypto from 'crypto';
import { getClientIp, toGroupKey } from './ip-group.js';
import { matchRuleset } from '../rules/matcher.js';
import { extractRequestFacts } from '../rules/extract-request-facts.js';

/**
 * @function sleep
 * @description promise wrapper around setTimeout
 *
 * @param {Number} ms milliseconds to wait
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * @class Queue
 * @description Concurrency admission gate, grouped by client ip /24 (or ipv6
 * /64 by default). Protects the upstream origin from a distributed bot
 * network by capping how many in-scope requests from a single network block
 * may be in flight at once, queueing a small number more, and rejecting the
 * rest with 429. State is coordinated across service instances via Postgres
 * (see ./store.js); any Postgres error fails the gate open rather than
 * blocking traffic. Requests from a client ip on the configured allowlist
 * bypass the gate entirely.
 */
class Queue {

  /**
   * @param {Object} opts
   * @param {Object} opts.config queue settings: methods, maxServedPerGroup,
   * maxPendingPerGroup, pendingTimeoutMs, pollIntervalMs, ipv4PrefixLength,
   * ipv6PrefixLength, staleActiveMs, sweepIntervalMs, idleGroupMs,
   * maxActiveDurationMs, clientIpHeader
   * @param {QueueStore} opts.store Postgres-backed queue store
   * @param {Object} opts.allowlist {isAllowed(ip)}, see ./allowlist.js
   * @param {Array<Array<Object>>} opts.rules compiled queue ruleset, see ../rules/load-rules.js
   * @param {Object} opts.logger logger instance
   */
  constructor(opts = {}) {
    this.config = opts.config;
    this.store = opts.store;
    this.allowlist = opts.allowlist;
    this.rules = opts.rules;
    this.logger = opts.logger;
    this._sweepTimer = null;
  }

  /**
   * @method startSweeping
   * @description start the background timer that reconciles stale active
   * rows (crash recovery) and prunes fully-idle group_state rows, so both
   * run reliably on a schedule rather than only opportunistically. Safe to
   * call more than once; only one timer is ever active.
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
   * @description one scheduled sweep tick: crash-recovery reconciliation
   * followed by idle group_state cleanup. Each step is independently
   * try/caught so one failing doesn't block the other.
   *
   * @returns {Promise<void>}
   */
  async _sweep() {
    try {
      await this.store.reconcileStale(this.config.staleActiveMs);
    } catch (e) {
      this.logger.error('queue: postgres error on scheduled reconcileStale', e);
    }
    try {
      await this.store.pruneIdleGroups(this.config.idleGroupMs);
    } catch (e) {
      this.logger.error('queue: postgres error on scheduled pruneIdleGroups', e);
    }
  }

  /**
   * @method isInScope
   * @description decide whether the queue should gate this request at all:
   * the method must be eligible, the client ip must not be on the allowlist,
   * and the request must match the configured queue ruleset.
   *
   * @param {Object} req express request object
   * @returns {Boolean}
   */
  isInScope(req) {
    if (this.config.methods.length && !this.config.methods.includes(req.method)) return false;
    if (this.allowlist.isAllowed(getClientIp(req, { trustedHeader: this.config.clientIpHeader }))) return false;
    return matchRuleset(this.rules, extractRequestFacts(req));
  }

  /**
   * @method getIpGroup
   * @description resolve the ip group key for a request, using the
   * configured ipv4/ipv6 prefix lengths.
   *
   * @param {Object} req express request object
   * @returns {String} ip group key
   */
  getIpGroup(req) {
    let ip = getClientIp(req, { trustedHeader: this.config.clientIpHeader });
    return toGroupKey(ip, {
      v4PrefixLength: this.config.ipv4PrefixLength,
      v6PrefixLength: this.config.ipv6PrefixLength
    });
  }

  /**
   * @method admit
   * @description decide whether a request may proceed to the proxy now. If
   * the request is out of scope, always proceeds with no Postgres access. If
   * in scope, attempts to claim an in-flight slot for the request's ip group;
   * if none are free, queues the request and waits (polling Postgres) until
   * admitted, until the client disconnects, or until the pending timeout
   * elapses. On any internal/Postgres error, logs and fails open.
   *
   * @param {Object} req express request object
   * @param {Object} res express response object
   * @returns {Promise<Boolean>} true if the caller should proceed to proxy
   * the request; false if this method already sent the HTTP response (429)
   * and the caller must return without further action
   */
  async admit(req, res) {
    if (!this.isInScope(req)) return true;

    let group = this.getIpGroup(req);
    let requestId = crypto.randomUUID();
    let cfg = this.config;

    try {
      if (await this.store.tryAdmit(requestId, group, cfg.maxServedPerGroup)) {
        this._attachReleaseHooks(req, res, requestId, group);
        return true;
      }
    } catch (e) {
      this.logger.error('queue: postgres error on tryAdmit, failing open', e);
      return true;
    }

    let enqueued = false;
    try {
      enqueued = await this.store.enqueueIfRoom(requestId, group, cfg.maxPendingPerGroup);
    } catch (e) {
      this.logger.error('queue: postgres error on enqueueIfRoom, failing open', e);
      return true;
    }

    if (!enqueued) {
      try {
        await this.store.reconcileStale(cfg.staleActiveMs);
      } catch (e) {
        this.logger.error('queue: postgres error on reconcileStale', e);
      }
      res.status(429).set('Retry-After', '5').send('Too many concurrent requests, please try again shortly');
      return false;
    }

    let outcome = await this._waitInQueue(req, requestId, group);

    if (outcome === 'admitted') {
      this._attachReleaseHooks(req, res, requestId, group);
      return true;
    }

    if (outcome === 'disconnected') {
      // client is already gone, nothing to send
      return false;
    }

    // timeout or internal error, fail closed with a 429 (error case already
    // logged inside _waitInQueue)
    res.status(429).set('Retry-After', '5').send('Too many concurrent requests, please try again shortly');
    return false;
  }

  /**
   * @method _attachReleaseHooks
   * @description attach completion/cleanup listeners to the response so an
   * active slot is always released (and the next queued request promoted)
   * exactly once, regardless of how the request ends. When
   * maxActiveDurationMs is configured (> 0), also force-disconnects the
   * request if it's still active once that duration elapses.
   *
   * @param {Object} req express request object
   * @param {Object} res express response object
   * @param {String} requestId unique id for this request
   * @param {String} group ip group key
   */
  _attachReleaseHooks(req, res, requestId, group) {
    let released = false;
    let durationTimer = null;

    let release = () => {
      if (released) return;
      released = true;
      if (durationTimer) clearTimeout(durationTimer);
      this.store.releaseAndPromote(requestId, group)
        .catch(e => this.logger.error('queue: postgres error on releaseAndPromote', e));
    };
    res.on('finish', release);
    res.on('close', release);

    if (this.config.maxActiveDurationMs > 0) {
      // no error/response body is sent here by design - this is a hard
      // disconnect, not a graceful error: headers may already be flushed for
      // a streaming response, so there's no way to tell the client anything
      // meaningful. Destroying res fires its 'close' event, which triggers
      // `release` above and, separately, the proxy's own close handler
      // (src/lib/proxy/index.js) aborting the upstream fetch.
      durationTimer = setTimeout(() => {
        if (released) return;
        this.logger.warn(`queue: force-disconnecting request ${requestId} (group ${group}) after exceeding max active duration ${this.config.maxActiveDurationMs}ms`);
        res.destroy();
      }, this.config.maxActiveDurationMs);
      durationTimer.unref();
    }
  }

  /**
   * @method _waitInQueue
   * @description poll Postgres until a queued request is promoted to
   * active, the client disconnects, or the pending timeout elapses.
   *
   * @param {Object} req express request object
   * @param {String} requestId unique id for this request
   * @param {String} group ip group key
   * @returns {Promise<'admitted'|'timeout'|'disconnected'>}
   */
  async _waitInQueue(req, requestId, group) {
    let cfg = this.config;
    let disconnected = false;
    let onClose = () => { disconnected = true; };
    req.on('close', onClose);

    try {
      let elapsed = 0;

      while (elapsed < cfg.pendingTimeoutMs) {
        if (disconnected) {
          try {
            let removed = await this.store.expirePending(requestId, group);
            if (!removed && await this.store.isActive(requestId)) {
              // promoted right as the client left, release it immediately
              await this.store.releaseAndPromote(requestId, group);
            }
          } catch (e) {
            this.logger.error('queue: postgres error cleaning up disconnected request', e);
          }
          return 'disconnected';
        }

        let active;
        try {
          active = await this.store.isActive(requestId);
        } catch (e) {
          this.logger.error('queue: postgres error polling isActive, failing open', e);
          return 'admitted';
        }
        if (active) return 'admitted';

        await sleep(cfg.pollIntervalMs);
        elapsed += cfg.pollIntervalMs;
      }

      try {
        let removed = await this.store.expirePending(requestId, group);
        if (!removed) {
          // lost the race with a concurrent promotion, check if we actually made it in
          if (await this.store.isActive(requestId)) return 'admitted';
        }
      } catch (e) {
        this.logger.error('queue: postgres error expiring timed out request, failing open', e);
        return 'admitted';
      }

      return 'timeout';
    } finally {
      req.removeListener('close', onClose);
    }
  }
}

export { Queue };
