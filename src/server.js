import path from 'path';
import { fileURLToPath } from 'url';
import http from 'http';
import config from './lib/config.js';
import { getLogger } from './lib/logger.js';
import { Db } from './lib/db/pool.js';
import { QueueStore } from './lib/queue/store.js';
import { createAllowlist } from './lib/queue/allowlist.js';
import { Queue } from './lib/queue/index.js';
import { DiskCache } from './lib/cache/index.js';
import { loadRuleset } from './lib/rules/load-rules.js';
import { createApp } from './app.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const logger = getLogger('cork-cache-n-queue');

/**
 * @function validateStartupConfig
 * @description validate the subset of config that must be correct before the
 * service can start: a parseable upstream URL, and a rules file whenever a
 * gate is enabled. Pure - no logging, no process exit - so it can be tested
 * in isolation.
 *
 * @param {Object} cfg config object, see ./lib/config.js
 * @returns {String|null} a description of the first problem found, or null if valid
 */
function validateStartupConfig(cfg) {
  if (!cfg.upstreamUrl) return 'CCNQ_UPSTREAM_URL is required';

  try {
    new URL(cfg.upstreamUrl);
  } catch (e) {
    return `CCNQ_UPSTREAM_URL "${cfg.upstreamUrl}" is not a valid URL`;
  }

  if (cfg.queue.enabled && !cfg.queue.rulesFile) {
    return 'CCNQ_QUEUE_RULES_FILE is required when CCNQ_QUEUE_ENABLED=true';
  }

  if (cfg.cache.enabled && !cfg.cache.rulesFile) {
    return 'CCNQ_CACHE_RULES_FILE is required when CCNQ_CACHE_ENABLED=true';
  }

  return null;
}

/**
 * @function buildServer
 * @description build the fully wired service - conditional queue (Postgres
 * schema init, store, allowlist, rules) and cache (rules, sweep timer) setup,
 * the express app, and a listening http.Server - without touching
 * process.exit or process signal handlers, so it can be started and torn
 * down independently (e.g. by a test). Assumes cfg has already been
 * validated by validateStartupConfig().
 *
 * @param {Object} cfg config object, see ./lib/config.js
 * @returns {Promise<Object>} {server, db, queue, cache} - db/queue/cache are
 * null when their respective gate is disabled
 */
async function buildServer(cfg) {
  let db = null;
  let queue = null;

  if (cfg.queue.enabled) {
    db = new Db({ postgres: cfg.postgres });
    await db.init(path.join(__dirname, '..', 'sql', '001-queue.sql'));

    let store = new QueueStore({ db, schema: cfg.postgres.schema });
    let allowlist = createAllowlist(cfg.queue.allowlist);
    let rules = loadRuleset(cfg.queue.rulesFile);

    queue = new Queue({
      config: { ...cfg.queue, clientIpHeader: cfg.clientIpHeader },
      store,
      allowlist,
      rules,
      logger: getLogger('queue')
    });
    logger.info('queue: enabled');
  } else {
    logger.info('queue: disabled');
  }

  let cache = null;

  if (cfg.cache.enabled) {
    let rules = loadRuleset(cfg.cache.rulesFile);
    cache = new DiskCache({ config: cfg.cache, rules, logger: getLogger('cache') });
    cache.startSweeping();
    logger.info('cache: enabled');
  } else {
    logger.info('cache: disabled');
  }

  let app = createApp({ cache, queue, upstreamUrl: cfg.upstreamUrl, logger });
  let server = http.createServer(app);

  await new Promise(resolve => server.listen(cfg.port, resolve));
  logger.info(`cork-cache-n-queue listening on port ${server.address().port}`);

  return { server, db, queue, cache };
}

/**
 * @function shutdown
 * @description stop accepting new connections, stop the cache sweep timer,
 * and close the Postgres pool (if any). Does not call process.exit - callers
 * that want the process to actually terminate do so themselves once this
 * resolves (see main()'s signal handlers below).
 *
 * @param {Object} opts {server, db, cache}
 * @returns {Promise<void>}
 */
function shutdown({ server, db, cache }) {
  if (cache) cache.stopSweeping();
  return new Promise(resolve => {
    server.close(async () => {
      if (db) await db.end();
      resolve();
    });
  });
}

/**
 * @function main
 * @description validate config, build the server, and wire up graceful
 * shutdown on SIGTERM/SIGINT. Exits the process (code 1) on a validation
 * failure or fatal startup error - this is the one place in the module
 * allowed to do that, so the rest of the bootstrap logic stays testable.
 *
 * @returns {Promise<void>}
 */
async function main() {
  let validationError = validateStartupConfig(config);
  if (validationError) {
    logger.error(validationError);
    process.exit(1);
  }

  let { server, db, cache } = await buildServer(config);

  let shuttingDown = false;

  function handleSignal(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`${signal} received, shutting down`);
    shutdown({ server, db, cache }).then(() => process.exit(0));
  }

  process.on('SIGTERM', () => handleSignal('SIGTERM'));
  process.on('SIGINT', () => handleSignal('SIGINT'));
}

// only auto-run when this file is executed directly (`node src/server.js`),
// not when imported - e.g. by tests exercising validateStartupConfig/buildServer/shutdown
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => {
    logger.error('server: fatal startup error', e);
    process.exit(1);
  });
}

export { validateStartupConfig, buildServer, shutdown, main };
