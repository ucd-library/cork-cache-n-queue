import fs from 'fs';
import { CacheStore } from './store.js';
import { MemoryIndex } from './memory-index.js';
import { deriveCacheKey } from './key.js';
import { matchRuleset } from '../rules/matcher.js';
import { extractRequestFacts } from '../rules/extract-request-facts.js';

/**
 * @function parseCacheControl
 * @description parse a Cache-Control header value into a plain object of
 * directive name -> value (true for valueless directives).
 *
 * @param {String} [headerValue=''] raw Cache-Control header value
 * @returns {Object<String, String|Boolean>}
 */
function parseCacheControl(headerValue = '') {
  let result = {};
  if (!headerValue) return result;

  headerValue.split(',').forEach(part => {
    let eq = part.indexOf('=');
    let key = (eq === -1 ? part : part.slice(0, eq)).trim().toLowerCase();
    if (!key) return;
    let value = eq === -1 ? true : part.slice(eq + 1).trim().replace(/^"|"$/g, '');
    result[key] = value;
  });

  return result;
}

/**
 * @class DiskCache
 * @description a local, per-instance on-disk response cache sitting in front
 * of the queue/origin. A cache hit is served without ever touching the queue
 * or the origin. No cross-replica coordination - each instance manages its
 * own cache independently, which is why there's no Postgres involvement
 * here, unlike the queue.
 */
class DiskCache {

  /**
   * @param {Object} opts
   * @param {Object} opts.config cache settings: dir, maxSizeBytes,
   * maxItemSizeBytes, ttlMs, respectCacheControl, stripSetCookie, methods,
   * varyHeaders, keyIncludeQuery, sweepIntervalMs
   * @param {Array<Array<Object>>} opts.rules compiled cache ruleset, see ../rules/load-rules.js
   * @param {Object} opts.logger logger instance
   */
  constructor(opts = {}) {
    this.config = opts.config;
    this.rules = opts.rules;
    this.logger = opts.logger;

    fs.mkdirSync(this.config.dir, { recursive: true });

    this.store = new CacheStore({ dir: this.config.dir });
    this.index = new MemoryIndex({
      maxSizeBytes: this.config.maxSizeBytes,
      onEvict: key => this.store.deleteEntry(key)
    });
    this.inFlight = new Map();
    this._sweepTimer = null;
  }

  /**
   * @method startSweeping
   * @description start the background TTL/size sweep timer. Safe to call
   * more than once; only one timer is ever active.
   *
   * @returns {void}
   */
  startSweeping() {
    if (this._sweepTimer) return;
    this._sweepTimer = setInterval(() => this.index.sweep(), this.config.sweepIntervalMs);
    this._sweepTimer.unref();
  }

  /**
   * @method stopSweeping
   * @description stop the background sweep timer, if running.
   *
   * @returns {void}
   */
  stopSweeping() {
    if (!this._sweepTimer) return;
    clearInterval(this._sweepTimer);
    this._sweepTimer = null;
  }

  /**
   * @method isInScope
   * @description decide whether the cache should even be consulted for this
   * request: the method must be eligible and the request must match the
   * configured cache ruleset.
   *
   * @param {Object} req express request object
   * @returns {Boolean}
   */
  isInScope(req) {
    if (this.config.methods.length && !this.config.methods.includes(req.method.toUpperCase())) return false;
    return matchRuleset(this.rules, extractRequestFacts(req));
  }

  /**
   * @method deriveKey
   * @description derive the cache key for a request using this cache's
   * configured vary-headers/query-inclusion settings.
   *
   * @param {Object} req express request object
   * @returns {String} cache key
   */
  deriveKey(req) {
    return deriveCacheKey(req, { varyHeaders: this.config.varyHeaders, includeQuery: this.config.keyIncludeQuery });
  }

  /**
   * @method getOrWait
   * @description check for a cache hit, waiting on an in-flight miss for the
   * same key (if any) instead of returning a miss outright - this is the
   * thundering-herd dedup: concurrent requests for a not-yet-cached key don't
   * each independently proceed to the queue/origin.
   *
   * @param {String} key cache key
   * @returns {Promise<Object|null>} cache entry {status, headers, bodyPath}, or null if the caller should proceed to the queue/origin
   */
  async getOrWait(key) {
    let hit = this.index.get(key);
    if (hit) return this.store.readEntry(key);

    let pending = this.inFlight.get(key);
    if (pending) {
      await pending;
      let afterWait = this.index.get(key);
      return afterWait ? this.store.readEntry(key) : null;
    }

    return null;
  }

  /**
   * @method claimLeader
   * @description claim responsibility for populating a not-yet-cached key.
   * Only one caller per key will receive a non-null function; concurrent
   * callers for the same key instead see their getOrWait() wait on it.
   *
   * @param {String} key cache key
   * @returns {Function|null} call with no arguments once this request's
   * attempt to populate the key has settled (cached or not); null if another
   * request is already the leader for this key
   */
  claimLeader(key) {
    if (this.inFlight.has(key)) return null;
    let resolveFn;
    let promise = new Promise(resolve => { resolveFn = resolve; });
    this.inFlight.set(key, promise);
    return () => {
      this.inFlight.delete(key);
      resolveFn();
    };
  }

  /**
   * @method beginWrite
   * @description claim responsibility for populating a not-yet-cached key
   * and open its write sink in one step, auto-releasing the claim once the
   * write settles (finish or abort) so concurrent getOrWait() callers
   * waiting on this key are always unblocked, even on error.
   *
   * @param {String} key cache key
   * @returns {Object|null} write sink {write(chunk), finish(status, headers), abort()},
   * or null if another request is already populating this key
   */
  beginWrite(key) {
    let release = this.claimLeader(key);
    if (!release) return null;

    let sink = this.openWriteSink(key);
    let released = false;
    let releaseOnce = () => {
      if (released) return;
      released = true;
      release();
    };

    return {
      write: chunk => sink.write(chunk),
      finish: async (status, headers) => {
        try {
          await sink.finish(status, headers);
        } finally {
          releaseOnce();
        }
      },
      abort: () => {
        sink.abort();
        releaseOnce();
      }
    };
  }

  /**
   * @method isCacheable
   * @description decide whether an upstream response may be cached, and
   * compute its TTL. A response carrying Set-Cookie is never cached unless
   * `stripSetCookie` is enabled, in which case the header is deleted from
   * `headers` in place (mutating the caller's object) and the response is
   * otherwise evaluated for cacheability as normal - the caller
   * (openWriteSink().finish()) relies on this mutation, since the same
   * headers object is what gets persisted to disk.
   *
   * @param {Object<String,String>} headers response headers, lowercase keys;
   * mutated in place when stripSetCookie strips Set-Cookie
   * @returns {Object} {cacheable: Boolean, ttlMs: Number}
   */
  isCacheable(headers) {
    if (headers['set-cookie']) {
      if (!this.config.stripSetCookie) return { cacheable: false, ttlMs: 0 };
      delete headers['set-cookie'];
    }

    if (!this.config.respectCacheControl) {
      return { cacheable: true, ttlMs: this.config.ttlMs };
    }

    let cc = parseCacheControl(headers['cache-control']);
    if (cc['no-store'] || cc['private'] || cc['no-cache']) {
      return { cacheable: false, ttlMs: 0 };
    }

    let rawMaxAge = cc['s-maxage'] !== undefined ? cc['s-maxage'] : cc['max-age'];
    let maxAge = parseInt(rawMaxAge);
    let ttlMs = isNaN(maxAge) ? this.config.ttlMs : maxAge * 1000;

    return { cacheable: true, ttlMs };
  }

  /**
   * @method openWriteSink
   * @description open a disk write sink for populating a cache entry while
   * the response streams to the client. Enforces maxItemSizeBytes while
   * streaming by aborting (without affecting the client-facing stream, which
   * the caller continues to drive independently).
   *
   * @param {String} key cache key
   * @returns {Object} {write(chunk), finish(status, headers), abort()}
   */
  openWriteSink(key) {
    let sink = this.store.createWriteSink(key);
    let maxItemSizeBytes = this.config.maxItemSizeBytes;
    let tooLarge = false;

    return {
      /**
       * @method write
       * @param {Buffer} chunk
       * @returns {void}
       */
      write: (chunk) => {
        if (tooLarge) return;
        sink.write(chunk);
        if (sink.size > maxItemSizeBytes) {
          tooLarge = true;
          sink.abort();
        }
      },

      /**
       * @method finish
       * @param {Number} status response status code
       * @param {Object<String,String>} headers response headers, lowercase keys
       * @returns {Promise<void>}
       */
      finish: async (status, headers) => {
        if (tooLarge) return;

        let { cacheable, ttlMs } = this.isCacheable(headers);
        if (!cacheable) {
          sink.abort();
          return;
        }

        let now = Date.now();
        let expiresAt = now + ttlMs;

        try {
          let { size } = await sink.finish({ status, headers, createdAt: now, expiresAt });
          this.index.set({ key, sizeBytes: size, expiresAt });
        } catch (e) {
          this.logger.error('cache: failed to finalize write sink', e);
        }
      },

      /**
       * @method abort
       * @returns {void}
       */
      abort: () => sink.abort()
    };
  }
}

export { DiskCache };
