const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade'
]);

/**
 * @function buildForwardHeaders
 * @description build the headers object to send upstream from an incoming
 * request's headers, stripping hop-by-hop headers plus Host and
 * Content-Length (fetch sets its own Host from the target URL, and manages
 * framing itself for a streamed body).
 *
 * @param {Object} incomingHeaders req.headers from the client request
 * @returns {Object<String,String>} headers to pass to fetch()
 */
function buildForwardHeaders(incomingHeaders) {
  let headers = {};
  for (let [name, value] of Object.entries(incomingHeaders)) {
    if (value === undefined) continue;
    let lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'host' || lower === 'content-length') continue;
    headers[name] = Array.isArray(value) ? value.join(', ') : value;
  }
  return headers;
}

/**
 * @function copyResponseHeaders
 * @description copy a fetch Response's headers onto an express response,
 * stripping hop-by-hop headers and preserving multiple Set-Cookie headers as
 * separate header lines rather than comma-merging them.
 *
 * @param {Response} fetchResponse native fetch Response
 * @param {Object} res express response object
 * @returns {void}
 */
function copyResponseHeaders(fetchResponse, res) {
  for (let [name, value] of fetchResponse.headers.entries()) {
    let lower = name.toLowerCase();
    if (HOP_BY_HOP_HEADERS.has(lower)) continue;
    if (lower === 'set-cookie') continue; // handled separately below, may be multi-valued
    res.setHeader(name, value);
  }

  if (typeof fetchResponse.headers.getSetCookie === 'function') {
    let cookies = fetchResponse.headers.getSetCookie();
    if (cookies.length) res.setHeader('set-cookie', cookies);
  }
}

/**
 * @function buildHeadersObject
 * @description build a plain, lowercase-keyed headers object from a fetch
 * Response, for use by the cache (Cache-Control inspection, Set-Cookie
 * presence check).
 *
 * @param {Response} fetchResponse native fetch Response
 * @returns {Object<String,String>}
 */
function buildHeadersObject(fetchResponse) {
  let headers = {};
  for (let [name, value] of fetchResponse.headers.entries()) {
    headers[name.toLowerCase()] = value;
  }
  return headers;
}

export { buildForwardHeaders, copyResponseHeaders, buildHeadersObject, HOP_BY_HOP_HEADERS };
