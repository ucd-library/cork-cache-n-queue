const env = process.env;

/**
 * @function parseIntOr
 * @description parse an env var as an integer, falling back to a default when
 * unset or unparseable.
 *
 * @param {String} value raw env var value
 * @param {Number} fallback default to use when value is missing/invalid
 * @returns {Number}
 */
function parseIntOr(value, fallback) {
  let parsed = parseInt(value);
  return isNaN(parsed) ? fallback : parsed;
}

/**
 * @function parseCsv
 * @description parse a comma-separated env var into a trimmed, non-empty
 * array of strings.
 *
 * @param {String} value raw env var value
 * @returns {Array<String>}
 */
function parseCsv(value) {
  if (!value) return [];
  return value.split(',').map(s => s.trim()).filter(s => s.length > 0);
}

let pgSchema = env.CCNQ_PG_SCHEMA || 'queue';
if (!/^[a-z_][a-z0-9_]*$/.test(pgSchema)) {
  throw new Error(`CCNQ_PG_SCHEMA "${pgSchema}" is not a safe schema identifier (must match ^[a-z_][a-z0-9_]*$)`);
}

const config = {

  port: parseIntOr(env.CCNQ_PORT, 3000),
  logLevel: env.CCNQ_LOG_LEVEL || 'info',
  upstreamUrl: env.CCNQ_UPSTREAM_URL || '',
  clientIpHeader: env.CCNQ_CLIENT_IP_HEADER || '',

  postgres: {
    host: env.CCNQ_PG_HOST || 'localhost',
    port: parseIntOr(env.CCNQ_PG_PORT, 5432),
    user: env.CCNQ_PG_USER || 'postgres',
    password: env.CCNQ_PG_PASSWORD || 'postgres',
    database: env.CCNQ_PG_DATABASE || 'postgres',
    schema: pgSchema,
    poolMax: parseIntOr(env.CCNQ_PG_POOL_MAX, 10),
    statementTimeoutMs: parseIntOr(env.CCNQ_PG_STATEMENT_TIMEOUT_MS, 5000)
  },

  queue: {
    enabled: env.CCNQ_QUEUE_ENABLED === 'true',
    rulesFile: env.CCNQ_QUEUE_RULES_FILE || '',
    methods: parseCsv(env.CCNQ_QUEUE_METHODS).map(m => m.toUpperCase()),
    maxServedPerGroup: parseIntOr(env.CCNQ_QUEUE_MAX_SERVED_PER_GROUP, 1),
    maxPendingPerGroup: parseIntOr(env.CCNQ_QUEUE_MAX_PENDING_PER_GROUP, 5),
    pendingTimeoutMs: parseIntOr(env.CCNQ_QUEUE_PENDING_TIMEOUT_MS, 10000),
    pollIntervalMs: parseIntOr(env.CCNQ_QUEUE_POLL_INTERVAL_MS, 250),
    ipv4PrefixLength: parseIntOr(env.CCNQ_QUEUE_IPV4_PREFIX_LENGTH, 24),
    ipv6PrefixLength: parseIntOr(env.CCNQ_QUEUE_IPV6_PREFIX_LENGTH, 64),
    staleActiveMs: parseIntOr(env.CCNQ_QUEUE_STALE_ACTIVE_MS, 300000),
    sweepIntervalMs: parseIntOr(env.CCNQ_QUEUE_SWEEP_INTERVAL_MS, 60000),
    idleGroupMs: parseIntOr(env.CCNQ_QUEUE_IDLE_GROUP_MS, 3600000),
    maxActiveDurationMs: parseIntOr(env.CCNQ_QUEUE_MAX_ACTIVE_DURATION_MS, 0),
    allowlist: env.CCNQ_QUEUE_ALLOWLIST || ''
  },

  cache: {
    enabled: env.CCNQ_CACHE_ENABLED === 'true',
    rulesFile: env.CCNQ_CACHE_RULES_FILE || '',
    dir: env.CCNQ_CACHE_DIR || './data/cache',
    maxSizeBytes: parseIntOr(env.CCNQ_CACHE_MAX_SIZE_BYTES, 1024 * 1024 * 1024),
    maxItemSizeBytes: parseIntOr(env.CCNQ_CACHE_MAX_ITEM_SIZE_BYTES, 10 * 1024 * 1024),
    ttlMs: parseIntOr(env.CCNQ_CACHE_TTL_MS, 60000),
    respectCacheControl: env.CCNQ_CACHE_RESPECT_CACHE_CONTROL !== 'false',
    stripSetCookie: env.CCNQ_CACHE_STRIP_SET_COOKIE === 'true',
    methods: parseCsv(env.CCNQ_CACHE_METHODS || 'GET,HEAD').map(m => m.toUpperCase()),
    varyHeaders: parseCsv(env.CCNQ_CACHE_VARY_HEADERS).map(h => h.toLowerCase()),
    keyIncludeQuery: env.CCNQ_CACHE_KEY_INCLUDE_QUERY !== 'false',
    sweepIntervalMs: parseIntOr(env.CCNQ_CACHE_SWEEP_INTERVAL_MS, 60000)
  }

};

export default config;
