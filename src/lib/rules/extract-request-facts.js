import { parseCookies } from '../cookies.js';

/**
 * @function parseQuery
 * @description parse the query string portion of a request's original URL
 * into a plain object of name/value pairs, mirroring parseCookies - not
 * Express's req.query, since that uses the "qs" library's extended parser
 * and produces nested objects/arrays for bracketed params; this stays a flat
 * string map to match facts.cookies.
 *
 * @param {String} originalUrl raw request URL, e.g. req.originalUrl
 * @returns {Object<String,String>} query param name/value pairs; duplicate
 * names keep the last occurrence
 */
function parseQuery(originalUrl = '') {
  let qIndex = originalUrl.indexOf('?');
  if (qIndex === -1) return {};

  let query = {};
  new URLSearchParams(originalUrl.slice(qIndex)).forEach((value, name) => {
    query[name] = value;
  });
  return query;
}

/**
 * @function extractRequestFacts
 * @description extract the subset of an incoming request relevant to rule
 * matching, shared by both the queue and cache rulesets.
 *
 * @param {Object} req express request object
 * @returns {Object} {path, headers, cookies, query}
 */
function extractRequestFacts(req) {
  return {
    path: req.path,
    headers: req.headers,
    cookies: parseCookies(req.headers.cookie || ''),
    query: parseQuery(req.originalUrl || '')
  };
}

export { extractRequestFacts };
