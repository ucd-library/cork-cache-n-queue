import express from 'express';
import compression from 'compression';
import { createGatewayHandler } from './controllers/gateway.js';

/**
 * @function createApp
 * @description build the express app. Deliberately has no body-parsing
 * middleware - express.json()/urlencoded() would consume the request stream
 * before the proxy can forward it to the origin.
 *
 * compression() runs ahead of the gateway handler so it wraps res for the
 * whole request: the proxy's upstream body always arrives already decoded
 * (see ../lib/proxy/headers.js - fetch() auto-decompresses and we strip the
 * now-stale Content-Encoding), so compression() re-encodes it on the way out
 * based on the requesting client's own Accept-Encoding, for both a live
 * MISS/BYPASS response and a cache-HIT replay alike.
 *
 * @param {Object} opts
 * @param {Object} [opts.cache] DiskCache instance, or omitted if the cache is disabled
 * @param {Object} [opts.queue] Queue instance, or omitted if the queue is disabled
 * @param {String} opts.upstreamUrl base URL of the upstream origin
 * @param {Object} opts.logger logger instance
 * @returns {Object} express app
 */
function createApp(opts) {
  let app = express();
  app.disable('x-powered-by');
  app.use(compression());
  app.use(createGatewayHandler(opts));
  return app;
}

export { createApp };
