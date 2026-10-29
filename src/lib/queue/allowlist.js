import net from 'net';
import { expandIpv6 } from './ip-group.js';
import { getLogger } from '../logger.js';

const logger = getLogger('queue:allowlist');

/**
 * @function ipv4ToBuffer
 * @description convert a dotted-quad ipv4 address into a 4-byte buffer
 *
 * @param {String} ip ipv4 address
 * @returns {Buffer}
 */
function ipv4ToBuffer(ip) {
  return Buffer.from(ip.split('.').map(Number));
}

/**
 * @function ipv6ToBuffer
 * @description convert a (possibly compressed) ipv6 address into a 16-byte
 * buffer
 *
 * @param {String} ip ipv6 address
 * @returns {Buffer}
 */
function ipv6ToBuffer(ip) {
  let hextets = expandIpv6(ip);
  let buffer = Buffer.alloc(16);
  hextets.forEach((hextet, i) => buffer.writeUInt16BE(parseInt(hextet || '0', 16), i * 2));
  return buffer;
}

/**
 * @function ipToBuffer
 * @description parse an ip address string into its address family and raw
 * byte buffer
 *
 * @param {String} ip ipv4 or ipv6 address
 * @returns {Object|null} {family: 4|6, buffer: Buffer}, or null if ip is not
 * a valid ipv4/ipv6 address
 */
function ipToBuffer(ip) {
  if (net.isIPv4(ip)) return { family: 4, buffer: ipv4ToBuffer(ip) };
  if (net.isIPv6(ip)) return { family: 6, buffer: ipv6ToBuffer(ip) };
  return null;
}

/**
 * @function applyMask
 * @description zero out every bit past the given prefix length in a copy of
 * an address buffer, for CIDR membership comparisons
 *
 * @param {Buffer} buffer raw address bytes
 * @param {Number} prefixLen number of leading bits to keep
 * @returns {Buffer} masked copy of buffer
 */
function applyMask(buffer, prefixLen) {
  let masked = Buffer.from(buffer);
  let bitsLeft = prefixLen;
  for (let i = 0; i < masked.length; i++) {
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      continue;
    }
    let mask = bitsLeft <= 0 ? 0x00 : (0xff << (8 - bitsLeft)) & 0xff;
    masked[i] = masked[i] & mask;
    bitsLeft = 0;
  }
  return masked;
}

/**
 * @function parseEntry
 * @description parse a single allowlist entry into a matcher. Accepts a bare
 * ip ("203.0.113.5"), a CIDR range ("203.0.113.0/24"), or an explicit
 * start-end range ("203.0.113.10-203.0.113.20"). Invalid entries are logged
 * and skipped rather than throwing, so one bad entry doesn't break the gate
 * for everyone else.
 *
 * @param {String} raw single allowlist entry, already trimmed
 * @returns {Object|null} {type: 'cidr', family, base, prefixLen} or
 * {type: 'range', family, start, end}, or null if unparseable
 */
function parseEntry(raw) {
  try {
    if (raw.includes('/')) {
      let [ip, prefixLenStr] = raw.split('/');
      let parsed = ipToBuffer(ip);
      let prefixLen = parseInt(prefixLenStr);
      let maxPrefixLen = parsed ? (parsed.family === 4 ? 32 : 128) : 0;
      if (!parsed || isNaN(prefixLen) || prefixLen < 0 || prefixLen > maxPrefixLen) {
        throw new Error('invalid cidr range');
      }
      return { type: 'cidr', family: parsed.family, base: applyMask(parsed.buffer, prefixLen), prefixLen };
    }

    if (raw.includes('-')) {
      let [startIp, endIp] = raw.split('-').map(s => s.trim());
      let start = ipToBuffer(startIp);
      let end = ipToBuffer(endIp);
      if (!start || !end || start.family !== end.family) {
        throw new Error('invalid ip range');
      }
      return { type: 'range', family: start.family, start: start.buffer, end: end.buffer };
    }

    let parsed = ipToBuffer(raw);
    if (!parsed) throw new Error('invalid ip');
    return { type: 'cidr', family: parsed.family, base: parsed.buffer, prefixLen: parsed.family === 4 ? 32 : 128 };
  } catch (e) {
    logger.warn(`queue: ignoring invalid allowlist entry "${raw}": ${e.message}`);
    return null;
  }
}

/**
 * @function parseAllowlist
 * @description parse a comma-separated allowlist config string into
 * matchers, dropping any entries that fail to parse
 *
 * @param {String} raw comma-separated list of ips, cidr ranges, and/or
 * explicit ip ranges, e.g. "203.0.113.5,198.51.100.0/24,192.0.2.10-192.0.2.20"
 * @returns {Array<Object>} parsed matcher entries
 */
function parseAllowlist(raw) {
  if (!raw) return [];
  return raw.split(',')
    .map(entry => entry.trim())
    .filter(entry => entry)
    .map(parseEntry)
    .filter(entry => entry);
}

/**
 * @function createAllowlist
 * @description build an allowlist matcher from a raw config string.
 *
 * @param {String} rawConfigString comma-separated allowlist entries
 * @returns {Object} {isAllowed(ip)}
 */
function createAllowlist(rawConfigString) {
  let entries = parseAllowlist(rawConfigString);

  /**
   * @function isAllowed
   * @description check whether a client ip matches any entry in the
   * configured allowlist. Allowlisted ips bypass the queue gate entirely.
   *
   * @param {String} ip client ip address (ipv4 or ipv6)
   * @returns {Boolean}
   */
  function isAllowed(ip) {
    if (!entries.length) return false;
    let parsed = ipToBuffer(ip);
    if (!parsed) return false;

    return entries.some(entry => {
      if (entry.family !== parsed.family) return false;
      if (entry.type === 'cidr') {
        return applyMask(parsed.buffer, entry.prefixLen).equals(entry.base);
      }
      return Buffer.compare(parsed.buffer, entry.start) >= 0 && Buffer.compare(parsed.buffer, entry.end) <= 0;
    });
  }

  return { isAllowed };
}

export { createAllowlist, parseAllowlist };
