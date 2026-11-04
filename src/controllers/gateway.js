import fs from 'fs';
import { proxyRequest } from '../lib/proxy/index.js';

/**
 * @function createGatewayHandler
 * @description build the single catch-all request handler implementing the
 * full gate order: denylist block-check (an ip currently blocked gets an
 * immediate 429, before cache or queue even run, and that denial is counted
 * too) -> cache check (a hit bypasses the queue and origin entirely) ->
 * queue admission gate (its own 429s are recorded against the client ip
 * too, the same as the pre-check's) -> proxy to the upstream origin ->
 * cache write (if eligible). Every
 * response carries an `X-Cache` header of `HIT`, `MISS`, or `BYPASS` (not in
 * the cache's configured scope at all) so callers can tell which path served
 * the response.
 *
 * @param {Object} opts
 * @param {Object} [opts.cache] DiskCache instance, or omitted if the cache is disabled
 * @param {Object} [opts.queue] Queue instance, or omitted if the queue is disabled
 * @param {Object} [opts.denylist] Denylist instance, or omitted if disabled
 * @param {String} opts.upstreamUrl base URL of the upstream origin
 * @param {Object} opts.logger logger instance
 * @returns {Function} express request handler
 */
function createGatewayHandler(opts) {
  let { cache, queue, denylist, upstreamUrl, logger } = opts;

  return async function gatewayHandler(req, res) {
    try {
      if (denylist) {
        let ip = denylist.getClientIp(req);
        let retryAfterSeconds = await denylist.isBlocked(ip);
        if (retryAfterSeconds !== null) {
          res.status(429).set('Retry-After', String(retryAfterSeconds)).send('Too many prior violations, temporarily blocked');
          // this request never reaches the queue, so without this call its
          // denial would never be counted at all - recordBlockedRequest()
          // only increments ip's raw per-day counter (no escalation, no
          // ip_block/ip_group_block writes), so it can't self-extend an
          // active block the way recordDenial() could if reused here.
          // Never rejects, so it's safe to fire-and-forget.
          denylist.recordBlockedRequest(ip);
          return;
        }
      }

      let cacheKey = null;
      let cacheEligible = false;

      if (cache && cache.isInScope(req)) {
        cacheEligible = true;
        cacheKey = cache.deriveKey(req);

        let hit = await cache.getOrWait(cacheKey);
        if (hit) {
          res.status(hit.status);
          for (let [name, value] of Object.entries(hit.headers || {})) {
            res.setHeader(name, value);
          }
          res.setHeader('x-cache', 'HIT');
          fs.createReadStream(hit.bodyPath).pipe(res);
          return;
        }
      }

      if (queue) {
        let admitted = await queue.admit(req, res);
        if (!admitted) {
          // queue already sent a 429, or the client disconnected while
          // waiting. Only an actual 429 counts as a denial - checking
          // res.statusCode (set synchronously by Queue.admit before it
          // returns false in both of its 429 paths) distinguishes that
          // from the "disconnected" case, which returns false without
          // sending any response at all. recordDenial() never rejects, so
          // it's safe to fire-and-forget.
          if (denylist && res.statusCode === 429) {
            denylist.recordDenial(denylist.getClientIp(req));
          }
          return;
        }
      }

      let cacheSink = cacheEligible ? cache.beginWrite(cacheKey) : null;
      await proxyRequest(req, res, { upstreamUrl, cacheSink, logger, cacheStatus: cacheEligible ? 'MISS' : 'BYPASS' });
    } catch (e) {
      logger.error('gateway: unhandled error', e);
      if (!res.headersSent) res.status(502).send('Bad Gateway');
    }
  };
}

export { createGatewayHandler };
