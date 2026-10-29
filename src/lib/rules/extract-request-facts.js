import { parseCookies } from '../cookies.js';

/**
 * @function extractRequestFacts
 * @description extract the subset of an incoming request relevant to rule
 * matching, shared by both the queue and cache rulesets.
 *
 * @param {Object} req express request object
 * @returns {Object} {path, headers, cookies}
 */
function extractRequestFacts(req) {
  return {
    path: req.path,
    headers: req.headers,
    cookies: parseCookies(req.headers.cookie || '')
  };
}

export { extractRequestFacts };
