import assert from 'node:assert';
import { parseArgs } from 'node:util';

const USAGE = `Usage: node scripts/real-world-test.js [baseUrl] [options]

Exercise a running cork-cache-n-queue instance to observe real cache and
queue behavior. baseUrl defaults to http://localhost:8000.

Options:
  --cache-path <path>                 path used for cache scenarios (default: /)
  --queue-path <path>                 path used for queue scenarios (default: /)
  --cache-concurrency <n>             burst size for cache dedup test (default: 5)
  --queue-concurrency <n>             burst size for queue mix test (default: 12)
  --queue-overflow-concurrency <n>    burst size for queue overflow test (default: 30)
  --timeout-ms <n>                    per-request timeout in ms (default: 15000)
  -h, --help                          print this message and exit
`;

/**
 * @function parseIntOr
 * @description parse a CLI flag value as an integer, falling back to a
 * default when missing or unparseable.
 * @param {String} value raw flag value
 * @param {Number} fallback default to use when value is missing/invalid
 * @returns {Number}
 */
function parseIntOr(value, fallback) {
  let parsed = parseInt(value);
  return isNaN(parsed) ? fallback : parsed;
}

/**
 * @function parseCliArgs
 * @description parse argv into a resolved options object with defaults,
 * using node:util's parseArgs so no extra dependency is required. Exits the
 * process directly (printing usage) on --help or an unparseable base URL.
 * @param {Array<String>} argv process.argv.slice(2)
 * @returns {Object} {baseUrl, cachePath, queuePath, cacheConcurrency, queueConcurrency, queueOverflowConcurrency, timeoutMs}
 */
function parseCliArgs(argv) {
  let { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'cache-path': { type: 'string' },
      'queue-path': { type: 'string' },
      'cache-concurrency': { type: 'string' },
      'queue-concurrency': { type: 'string' },
      'queue-overflow-concurrency': { type: 'string' },
      'timeout-ms': { type: 'string' },
      help: { type: 'boolean', short: 'h' }
    }
  });

  if (values.help) {
    console.log(USAGE);
    process.exit(0);
  }

  let rawBaseUrl = positionals[0] || 'http://localhost:8000';
  let baseUrl;
  try {
    baseUrl = new URL(rawBaseUrl).toString().replace(/\/$/, '');
  } catch (e) {
    console.error(`Invalid base URL: "${rawBaseUrl}"\n`);
    console.error(USAGE);
    process.exit(1);
  }

  return {
    baseUrl,
    cachePath: values['cache-path'] || '/',
    queuePath: values['queue-path'] || '/',
    cacheConcurrency: parseIntOr(values['cache-concurrency'], 5),
    queueConcurrency: parseIntOr(values['queue-concurrency'], 12),
    queueOverflowConcurrency: parseIntOr(values['queue-overflow-concurrency'], 30),
    timeoutMs: parseIntOr(values['timeout-ms'], 15000)
  };
}

/**
 * @function nonceParam
 * @description build a short, unique query-string fragment so a request
 * targets a cache key no earlier request in this run could have populated.
 * @returns {String} e.g. "rwt=1830000000000-a1b2c3"
 */
function nonceParam() {
  let random = Math.random().toString(36).slice(2, 8);
  return `rwt=${Date.now()}-${random}`;
}

/**
 * @function buildNonceUrls
 * @description build `count` URLs for the same path, each carrying its own
 * unique cache-busting query param. Used for queue scenarios so concurrent
 * requests can never collapse onto one cache entry and get served as cache
 * HITs that bypass the queue gate entirely - the gateway handler checks the
 * cache before the queue and returns immediately on a hit.
 * @param {String} baseUrl
 * @param {String} path
 * @param {Number} count
 * @returns {Array<String>}
 */
function buildNonceUrls(baseUrl, path, count) {
  let urls = [];
  for (let i = 0; i < count; i++) {
    urls.push(`${baseUrl}${path}${path.includes('?') ? '&' : '?'}${nonceParam()}-${i}`);
  }
  return urls;
}

/**
 * @function timedFetch
 * @description perform a fetch(), measuring latency and normalizing both
 * HTTP and network/timeout failures into one return shape, so callers never
 * need try/catch to interpret a result.
 * @param {String} url
 * @param {Object} [opts]
 * @param {Number} [opts.timeoutMs=15000]
 * @returns {Promise<Object>} {ok, status, headers, body, elapsedMs, error}
 */
async function timedFetch(url, opts = {}) {
  let timeoutMs = opts.timeoutMs || 15000;
  let controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), timeoutMs);
  let start = Date.now();
  try {
    let res = await fetch(url, { signal: controller.signal });
    let body = await res.text();
    return { ok: true, status: res.status, headers: res.headers, body, elapsedMs: Date.now() - start, error: null };
  } catch (e) {
    return { ok: false, status: null, headers: null, body: null, elapsedMs: Date.now() - start, error: e };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @function printEvidence
 * @description pretty-print a flat evidence object as indented key: value
 * lines under a test result.
 * @param {Object} evidence
 * @returns {void}
 */
function printEvidence(evidence) {
  if (!evidence) return;
  for (let [key, value] of Object.entries(evidence)) {
    console.log(`      ${key}: ${JSON.stringify(value)}`);
  }
}

/**
 * @function runTest
 * @description run one named scenario end-to-end: print its name and
 * description, invoke it, and print its verdict plus evidence - converting
 * an unexpected thrown error into a FAIL so one broken scenario never aborts
 * the whole run.
 * @param {Object} summary mutable {pass, fail, info} counters, updated in place
 * @param {String} name
 * @param {String} description
 * @param {Function} testFn () => Promise<{status: 'pass'|'fail'|'info', message: String, evidence: Object}>
 * @returns {Promise<void>}
 */
async function runTest(summary, name, description, testFn) {
  console.log(`\n[TEST] ${name}`);
  console.log(`  ${description}`);

  let result;
  try {
    result = await testFn();
  } catch (e) {
    result = { status: 'fail', message: `threw: ${e.message}`, evidence: null };
  }

  let label = { pass: 'PASS', fail: 'FAIL', info: 'INFO' }[result.status] || 'INFO';
  console.log(`  -> ${label}: ${result.message}`);
  printEvidence(result.evidence);

  summary[result.status] = (summary[result.status] || 0) + 1;
}

/**
 * @function printSummary
 * @description print the final pass/fail/info tally for the run.
 * @param {Object} summary {pass, fail, info}
 * @returns {void}
 */
function printSummary(summary) {
  console.log('\n--- Summary ---');
  console.log(`  pass: ${summary.pass || 0}  fail: ${summary.fail || 0}  info: ${summary.info || 0}`);
}

/**
 * @function testCacheMissThenHit
 * @description hit the same cache-busted URL twice and check for a
 * MISS-then-HIT transition on the X-Cache header, with matching bodies.
 * @param {Object} opts {baseUrl, cachePath, timeoutMs}
 * @returns {Promise<Object>} {status, message, evidence}
 */
async function testCacheMissThenHit(opts) {
  let url = `${opts.baseUrl}${opts.cachePath}${opts.cachePath.includes('?') ? '&' : '?'}${nonceParam()}`;

  let first = await timedFetch(url, { timeoutMs: opts.timeoutMs });
  if (!first.ok) return { status: 'fail', message: 'first request failed/timed out', evidence: { error: first.error?.message } };

  let second = await timedFetch(url, { timeoutMs: opts.timeoutMs });
  if (!second.ok) return { status: 'fail', message: 'second request failed/timed out', evidence: { error: second.error?.message } };

  let firstCache = first.headers.get('x-cache');
  let secondCache = second.headers.get('x-cache');
  let evidence = { firstStatus: first.status, firstXCache: firstCache, secondStatus: second.status, secondXCache: secondCache };

  if (!firstCache || !secondCache) {
    return { status: 'info', message: 'no X-Cache header observed - cache gate may be disabled or not wired for this path', evidence };
  }
  if (firstCache === 'BYPASS') {
    return { status: 'info', message: 'path is out of cache scope - try --cache-path pointed at a cache-eligible path', evidence };
  }
  if (firstCache === 'MISS' && secondCache === 'HIT') {
    try {
      assert.strictEqual(first.body, second.body);
    } catch {
      return { status: 'fail', message: 'HIT body differs from the original MISS body', evidence };
    }
    return { status: 'pass', message: 'MISS then HIT observed with matching bodies', evidence };
  }
  if (firstCache === 'MISS' && secondCache === 'MISS') {
    return { status: 'fail', message: 'second identical GET was still MISS - caching does not appear to be happening for an in-scope path', evidence };
  }
  return { status: 'info', message: `unexpected X-Cache sequence (${firstCache} -> ${secondCache})`, evidence };
}

/**
 * @function testCacheConcurrentDedup
 * @description fire several concurrent identical requests and check that any
 * response tagged HIT matches the body served by a MISS/BYPASS response in
 * the same batch, reporting the observed X-Cache distribution as evidence of
 * (but not proof of) origin dedup. A body mismatch is only a hard failure
 * when a HIT is involved - without caching engaged, the upstream is free to
 * return different content per request, so mismatched BYPASS/MISS bodies are
 * informational only.
 * @param {Object} opts {baseUrl, cachePath, cacheConcurrency, timeoutMs}
 * @returns {Promise<Object>} {status, message, evidence}
 */
async function testCacheConcurrentDedup(opts) {
  let url = `${opts.baseUrl}${opts.cachePath}${opts.cachePath.includes('?') ? '&' : '?'}${nonceParam()}`;
  let results = await Promise.all(
    Array.from({ length: opts.cacheConcurrency }, () => timedFetch(url, { timeoutMs: opts.timeoutMs }))
  );

  let ok = results.filter(r => r.ok && r.status >= 200 && r.status < 300);
  let xCacheCounts = {};
  for (let r of results) {
    let value = r.ok ? (r.headers.get('x-cache') || 'none') : 'error';
    xCacheCounts[value] = (xCacheCounts[value] || 0) + 1;
  }

  let hits = ok.filter(r => r.headers.get('x-cache') === 'HIT');
  let nonHits = ok.filter(r => r.headers.get('x-cache') !== 'HIT');
  if (hits.length > 0 && nonHits.length > 0) {
    let referenceBody = nonHits[0].body;
    for (let hit of hits) {
      if (hit.body !== referenceBody) {
        return { status: 'fail', message: 'a HIT response body differs from a MISS/BYPASS response body in the same concurrent batch', evidence: { concurrency: opts.cacheConcurrency, xCacheCounts } };
      }
    }
  }

  return {
    status: 'info',
    message: 'no HIT/non-HIT body mismatch observed; true origin-hit dedup is not observable from outside the process',
    evidence: { concurrency: opts.cacheConcurrency, xCacheCounts }
  };
}

/**
 * @function classifyBurst
 * @description classify a batch of timedFetch results into rejected
 * (429), admitted (2xx/3xx), and errored (network/timeout failure) groups.
 * @param {Array<Object>} results timedFetch results
 * @returns {Object} {rejected, admitted, errored}
 */
function classifyBurst(results) {
  let rejected = [];
  let admitted = [];
  let errored = [];
  for (let r of results) {
    if (!r.ok) errored.push(r);
    else if (r.status === 429) rejected.push(r);
    else admitted.push(r);
  }
  return { rejected, admitted, errored };
}

/**
 * @function testQueueBurstMix
 * @description fire a concurrent burst of uniquely-keyed requests at the
 * queue path and report the mix of immediate/delayed/rejected outcomes.
 * @param {Object} opts {baseUrl, queuePath, queueConcurrency, timeoutMs}
 * @returns {Promise<Object>} {status, message, evidence}
 */
async function testQueueBurstMix(opts) {
  let urls = buildNonceUrls(opts.baseUrl, opts.queuePath, opts.queueConcurrency);
  let results = await Promise.all(urls.map(url => timedFetch(url, { timeoutMs: opts.timeoutMs })));
  let { rejected, admitted, errored } = classifyBurst(results);

  if (errored.length > 0) {
    return { status: 'fail', message: 'one or more requests errored/timed out - the proxy may be hung', evidence: { errored: errored.length } };
  }

  let missingRetryAfter = rejected.filter(r => !r.headers.get('retry-after'));
  if (missingRetryAfter.length > 0) {
    return { status: 'fail', message: '429 response(s) missing Retry-After header', evidence: { missingRetryAfter: missingRetryAfter.length } };
  }

  let latencies = admitted.map(r => r.elapsedMs).sort((a, b) => a - b);
  let spread = latencies.length > 1 ? latencies[latencies.length - 1] - latencies[0] : 0;
  let evidence = { concurrency: opts.queueConcurrency, admitted: admitted.length, rejected: rejected.length, latencySpreadMs: spread };

  if (rejected.length === 0 && spread < 250) {
    return { status: 'info', message: 'no rejection or queuing delay observed - queue may be disabled, path out of scope, or try a higher --queue-concurrency', evidence };
  }
  if (rejected.length === 0) {
    return { status: 'pass', message: 'mix of immediate/delayed completions suggests admission queuing is active', evidence };
  }
  if (admitted.length === 0) {
    return { status: 'pass', message: 'all requests rejected - try a lower --queue-concurrency to also see admitted requests', evidence };
  }
  return { status: 'pass', message: 'mix of admitted and rejected requests observed', evidence };
}

/**
 * @function testQueueOverflow
 * @description fire a larger concurrent burst intended to saturate the
 * queue's admit+pending capacity and confirm any rejection carries a valid
 * Retry-After header.
 * @param {Object} opts {baseUrl, queuePath, queueOverflowConcurrency, timeoutMs}
 * @returns {Promise<Object>} {status, message, evidence}
 */
async function testQueueOverflow(opts) {
  let urls = buildNonceUrls(opts.baseUrl, opts.queuePath, opts.queueOverflowConcurrency);
  let results = await Promise.all(urls.map(url => timedFetch(url, { timeoutMs: opts.timeoutMs })));
  let { rejected, admitted, errored } = classifyBurst(results);

  if (errored.length > 0) {
    return { status: 'fail', message: 'one or more requests errored/timed out - the proxy may be hung', evidence: { errored: errored.length } };
  }

  let evidence = { concurrency: opts.queueOverflowConcurrency, admitted: admitted.length, rejected: rejected.length };

  if (rejected.length === 0) {
    return { status: 'info', message: `no 429 observed at --queue-overflow-concurrency=${opts.queueOverflowConcurrency} - queue may be disabled, caps configured higher than this burst, or this client IP is allowlisted`, evidence };
  }

  let invalid = rejected.filter(r => {
    let value = Number(r.headers.get('retry-after'));
    return isNaN(value) || value < 0;
  });
  if (invalid.length > 0) {
    return { status: 'fail', message: '429 response(s) with missing/invalid Retry-After header', evidence: { ...evidence, invalidRetryAfter: invalid.length } };
  }

  return { status: 'pass', message: '429 responses observed with valid Retry-After headers', evidence };
}

/**
 * @function testUnknownPathSanity
 * @description hit an arbitrary unknown path and confirm the proxy responds
 * (even a 502 is a legitimate response, not a crash) rather than hanging.
 * @param {Object} opts {baseUrl, timeoutMs}
 * @returns {Promise<Object>} {status, message, evidence}
 */
async function testUnknownPathSanity(opts) {
  let url = `${opts.baseUrl}/__real-world-test-sanity-${nonceParam()}`;
  let result = await timedFetch(url, { timeoutMs: opts.timeoutMs });

  if (!result.ok) {
    return { status: 'fail', message: 'request failed/timed out - the proxy may be hung', evidence: { error: result.error?.message } };
  }

  let evidence = { status: result.status, xCache: result.headers.get('x-cache') };
  if (result.status === 502) {
    return { status: 'info', message: '502 received - this is a valid response but double-check CCNQ_UPSTREAM_URL on the server', evidence };
  }
  return { status: 'pass', message: `proxy responded with status ${result.status}`, evidence };
}

/**
 * @function testContentLengthSanity
 * @description confirm a response's Content-Length header (when present)
 * matches the actual number of bytes received.
 * @param {Object} opts {baseUrl, cachePath, timeoutMs}
 * @returns {Promise<Object>} {status, message, evidence}
 */
async function testContentLengthSanity(opts) {
  let url = `${opts.baseUrl}${opts.cachePath}`;
  let result = await timedFetch(url, { timeoutMs: opts.timeoutMs });

  if (!result.ok) {
    return { status: 'fail', message: 'request failed/timed out', evidence: { error: result.error?.message } };
  }

  let contentLength = result.headers.get('content-length');
  if (!contentLength) {
    return { status: 'info', message: 'no Content-Length header on this response - skipping', evidence: { status: result.status } };
  }

  let actualBytes = Buffer.byteLength(result.body);
  let evidence = { contentLength: Number(contentLength), actualBytes };
  if (Number(contentLength) !== actualBytes) {
    return { status: 'fail', message: 'Content-Length does not match actual body size', evidence };
  }
  return { status: 'pass', message: 'Content-Length matches actual body size', evidence };
}

/**
 * @function main
 * @description parse CLI args and run all scenarios in sequence against the
 * target instance, printing a final pass/fail/info summary.
 * @returns {Promise<void>}
 */
async function main() {
  let opts = parseCliArgs(process.argv.slice(2));

  console.log(`cork-cache-n-queue real-world test runner`);
  console.log(`  target: ${opts.baseUrl}`);
  console.log(`  cache path: ${opts.cachePath}  queue path: ${opts.queuePath}`);

  let summary = { pass: 0, fail: 0, info: 0 };

  await runTest(summary, 'Cache: repeated GET shows MISS then HIT',
    'GET a fresh URL twice and check for a MISS -> HIT transition with matching bodies',
    () => testCacheMissThenHit(opts));

  await runTest(summary, 'Cache: concurrent identical requests - dedup evidence',
    `fire ${opts.cacheConcurrency} concurrent GETs at one fresh URL and compare bodies/X-Cache values`,
    () => testCacheConcurrentDedup(opts));

  await runTest(summary, 'Queue: burst of concurrent requests shows a mix of outcomes',
    `fire ${opts.queueConcurrency} concurrent uniquely-keyed GETs and classify admitted/rejected/delayed`,
    () => testQueueBurstMix(opts));

  await runTest(summary, 'Queue: overflow burst triggers 429 with Retry-After',
    `fire ${opts.queueOverflowConcurrency} concurrent uniquely-keyed GETs to try to saturate admission capacity`,
    () => testQueueOverflow(opts));

  await runTest(summary, 'Sanity: proxy handles an arbitrary path without crashing',
    'GET an unknown path once and confirm the proxy responds',
    () => testUnknownPathSanity(opts));

  await runTest(summary, 'Sanity: Content-Length matches actual body size',
    'GET the cache path once and compare Content-Length to actual bytes received',
    () => testContentLengthSanity(opts));

  printSummary(summary);
  process.exitCode = summary.fail > 0 ? 1 : 0;
}

main().catch(e => {
  console.error('real-world-test: unexpected error', e);
  process.exitCode = 1;
});
