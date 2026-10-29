import fs from 'fs';
import { proxyRequest } from '../lib/proxy/index.js';

/**
 * @function createGatewayHandler
 * @description build the single catch-all request handler implementing the
 * full gate order: cache check (a hit bypasses the queue and origin
 * entirely) -> queue admission gate -> proxy to the upstream origin -> cache
 * write (if eligible). Every response carries an `X-Cache` header of `HIT`,
 * `MISS`, or `BYPASS` (not in the cache's configured scope at all) so
 * callers can tell which path served the response.
 *
 * @param {Object} opts
 * @param {Object} [opts.cache] DiskCache instance, or omitted if the cache is disabled
 * @param {Object} [opts.queue] Queue instance, or omitted if the queue is disabled
 * @param {String} opts.upstreamUrl base URL of the upstream origin
 * @param {Object} opts.logger logger instance
 * @returns {Function} express request handler
 */
function createGatewayHandler(opts) {
  let { cache, queue, upstreamUrl, logger } = opts;

  return async function gatewayHandler(req, res) {
    try {
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
        if (!admitted) return; // queue already sent a 429, or the client disconnected while waiting
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
