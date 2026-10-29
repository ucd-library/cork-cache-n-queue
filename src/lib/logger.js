import { createLogger } from '@ucd-lib/logger';
import config from './config.js';

const loggers = new Map();

/**
 * @function getLogger
 * @description get (or lazily create) a named logger instance, using the
 * configured log level.
 *
 * @param {String} [name='cork-cache-n-queue'] logger name, shown in log output
 * @returns {Object} logger instance with trace/debug/info/warn/error/fatal methods
 */
function getLogger(name = 'cork-cache-n-queue') {
  if (!loggers.has(name)) {
    loggers.set(name, createLogger({ name, level: config.logLevel, noInitMsg: true }));
  }
  return loggers.get(name);
}

export default getLogger();
export { getLogger };
