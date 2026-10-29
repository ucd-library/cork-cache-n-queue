/**
 * @function parseCookies
 * @description parse a raw Cookie request header into a plain object of
 * name/value pairs. Hand-rolled to avoid a dependency for something this
 * small; not a full RFC 6265 implementation, but handles the common cases
 * (quoted values, percent-encoding, duplicate names).
 *
 * @param {String} [header=''] raw Cookie header value
 * @returns {Object<String,String>} cookie name/value pairs; duplicate names
 * keep the last occurrence
 */
function parseCookies(header = '') {
  let cookies = {};
  if (!header) return cookies;

  header.split(';').forEach(pair => {
    let eq = pair.indexOf('=');
    if (eq === -1) return;

    let name = pair.slice(0, eq).trim();
    let value = pair.slice(eq + 1).trim();
    if (!name) return;

    if (value.length >= 2 && value[0] === '"' && value[value.length - 1] === '"') {
      value = value.slice(1, -1);
    }

    try {
      value = decodeURIComponent(value);
    } catch (e) {
      // leave value as-is if it isn't validly percent-encoded
    }

    cookies[name] = value;
  });

  return cookies;
}

export { parseCookies };
