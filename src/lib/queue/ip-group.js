import net from 'net';

/**
 * @function getClientIp
 * @description resolve the real client ip for a request. If a trustedHeader
 * is configured, trusts that header's value (e.g. Cloudflare's
 * CF-Connecting-IP, or a custom header for local testing); otherwise always
 * uses the raw socket address. There is no hardcoded header name - a header
 * present on the request is only trusted when explicitly configured.
 *
 * @param {Object} req express request object
 * @param {Object} [opts={}] options
 * @param {String} [opts.trustedHeader] header name to trust for client ip, lowercase
 * @returns {String} client ip address
 */
function getClientIp(req, opts = {}) {
  if (opts.trustedHeader) {
    let value = req.headers[opts.trustedHeader.toLowerCase()];
    if (value) return Array.isArray(value) ? value[0] : value;
  }
  return req.socket.remoteAddress || '';
}

/**
 * @function expandIpv6
 * @description expand a (possibly compressed) IPv6 address into its full 8
 * hextet representation.
 *
 * @param {String} ip ipv6 address, may contain '::' shorthand
 * @returns {Array<String>} 8 hextets, each a 1-4 char hex string
 */
function expandIpv6(ip) {
  let [head, tail] = ip.split('::');
  let headParts = head ? head.split(':') : [];
  let tailParts = tail ? tail.split(':') : [];
  let missing = 8 - (headParts.length + tailParts.length);

  if (ip.indexOf('::') === -1) {
    headParts = ip.split(':');
    tailParts = [];
    missing = 0;
  }

  return [...headParts, ...new Array(Math.max(missing, 0)).fill('0'), ...tailParts];
}

/**
 * @function toGroupKey
 * @description mask a client ip to a CIDR-style group key, so e.g.
 * 168.100.3.42 and 168.100.3.99 both resolve to the same group. Only
 * byte-aligned (ipv4) or hextet-aligned (ipv6) prefix lengths are supported,
 * which keeps the masking a simple truncation instead of requiring bitmask
 * math; the defaults (/24, /64) are already aligned.
 *
 * @param {String} ip client ip address (ipv4 or ipv6)
 * @param {Object} [opts={}] options
 * @param {Number} [opts.v4PrefixLength=24] ipv4 group prefix length, must be a multiple of 8
 * @param {Number} [opts.v6PrefixLength=64] ipv6 group prefix length, must be a multiple of 16
 * @returns {String} group key, e.g. "v4:168.100.3.0/24" or "v6:2001:db8::/64"
 */
function toGroupKey(ip, opts = {}) {
  let v4PrefixLength = opts.v4PrefixLength || 24;
  let v6PrefixLength = opts.v6PrefixLength || 64;

  if (net.isIPv4(ip)) {
    let octets = ip.split('.');
    let keep = Math.floor(v4PrefixLength / 8);
    let masked = octets.map((octet, i) => i < keep ? octet : '0');
    return `v4:${masked.join('.')}/${v4PrefixLength}`;
  }

  if (net.isIPv6(ip)) {
    let hextets = expandIpv6(ip);
    let keep = Math.floor(v6PrefixLength / 16);
    let masked = hextets.map((hextet, i) => i < keep ? hextet : '0');
    return `v6:${masked.join(':')}/${v6PrefixLength}`;
  }

  // unrecognized address format, group together rather than throw so
  // the queue degrades to a single shared group instead of failing
  return `unknown:${ip}`;
}

export { getClientIp, toGroupKey, expandIpv6 };
