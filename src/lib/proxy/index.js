import { Readable } from 'stream';
import { buildForwardHeaders, copyResponseHeaders, buildHeadersObject } from './headers.js';

const NON_BODY_METHODS = new Set(['GET', 'HEAD']);

/**
 * @function proxyRequest
 * @description proxy an incoming request to the configured upstream origin
 * using native fetch(), streaming the request and response bodies in both
 * directions. Optionally tees the response body into a cache write sink as
 * it streams back to the client, without ever blocking client delivery on
 * the cache write. A client disconnecting mid-request aborts the upstream
 * fetch (and therefore the in-progress cache write, if any).
 *
 * Disconnect detection is keyed off `res`'s 'close' event (guarded by
 * `res.writableEnded`), not `req`'s: a request stream's 'close' event fires
 * on ordinary completion too (once its body has been fully read), so using
 * it here would abort the upstream fetch for every normal non-GET/HEAD
 * request the moment its body finished streaming through.
 *
 * @param {Object} req express request object
 * @param {Object} res express response object
 * @param {Object} opts
 * @param {String} opts.upstreamUrl base URL of the upstream origin
 * @param {Object} [opts.cacheSink] optional write sink from DiskCache.openWriteSink(), see ../cache/index.js
 * @param {Object} opts.logger logger instance
 * @returns {Promise<void>}
 */
async function proxyRequest(req, res, opts) {
  let { upstreamUrl, cacheSink, logger } = opts;
  let target = new URL(req.originalUrl, upstreamUrl);
  let method = req.method.toUpperCase();
  let hasBody = !NON_BODY_METHODS.has(method);

  let controller = new AbortController();
  let onResClose = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.on('close', onResClose);
  let cleanup = () => res.removeListener('close', onResClose);

  let fetchResponse;
  try {
    fetchResponse = await fetch(target, {
      method,
      headers: buildForwardHeaders(req.headers),
      body: hasBody ? Readable.toWeb(req) : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'manual',
      signal: controller.signal
    });
  } catch (e) {
    cleanup();
    if (cacheSink) cacheSink.abort();
    if (controller.signal.aborted) return; // client disconnected, nothing to send
    logger.error('proxy: upstream fetch failed', e);
    if (!res.headersSent) res.status(502).send('Bad Gateway');
    return;
  }

  res.status(fetchResponse.status);
  copyResponseHeaders(fetchResponse, res);

  if (!fetchResponse.body) {
    cleanup();
    if (cacheSink) cacheSink.abort();
    res.end();
    return;
  }

  let headersForCache = cacheSink ? buildHeadersObject(fetchResponse) : null;
  let nodeStream = Readable.fromWeb(fetchResponse.body);

  if (cacheSink) {
    nodeStream.on('data', chunk => cacheSink.write(chunk));
  }

  nodeStream.on('error', e => {
    cleanup();
    if (cacheSink) cacheSink.abort();
    if (!controller.signal.aborted) logger.error('proxy: error streaming upstream response', e);
    res.destroy(e);
  });

  nodeStream.on('end', () => {
    cleanup();
    if (cacheSink) cacheSink.finish(fetchResponse.status, headersForCache);
  });

  nodeStream.pipe(res);
}

export { proxyRequest };
