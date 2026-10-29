import express from 'express';
import { createGatewayHandler } from './controllers/gateway.js';

/**
 * @function createApp
 * @description build the express app. Deliberately has no body-parsing
 * middleware - express.json()/urlencoded() would consume the request stream
 * before the proxy can forward it to the origin.
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
  app.use(createGatewayHandler(opts));
  return app;
}

export { createApp };
