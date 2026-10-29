import crypto from 'crypto';

/**
 * @function deriveCacheKey
 * @description derive a stable cache key for a request from its method,
 * path, optionally its query string, and optionally a configured set of
 * "vary" request headers.
 *
 * @param {Object} req express request object
 * @param {Object} [opts={}] options
 * @param {Array<String>} [opts.varyHeaders=[]] lowercase header names folded into the key
 * @param {Boolean} [opts.includeQuery=true] whether to include the query string in the key
 * @returns {String} sha256 hex digest cache key
 */
function deriveCacheKey(req, opts = {}) {
  let varyHeaders = opts.varyHeaders || [];
  let includeQuery = opts.includeQuery !== false;

  let method = req.method.toUpperCase();
  let path = req.path;

  let query = '';
  if (includeQuery) {
    let qIndex = req.originalUrl.indexOf('?');
    query = qIndex === -1 ? '' : req.originalUrl.slice(qIndex);
  }

  let varyPart = varyHeaders
    .map(name => `${name}=${req.headers[name.toLowerCase()] || ''}`)
    .join('&');

  let material = `${method}\n${path}\n${query}\n${varyPart}`;
  return crypto.createHash('sha256').update(material).digest('hex');
}

export { deriveCacheKey };
