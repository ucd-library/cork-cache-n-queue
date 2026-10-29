import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * @class CacheStore
 * @description low-level disk I/O for the cache: content-addressable,
 * hash-sharded storage of a {.meta.json, .body} pair per entry, with
 * tmp-file-then-rename writes so a concurrent reader never observes a
 * partially written entry. No in-memory bookkeeping - see ./memory-index.js
 * for the index that tracks what's on disk.
 */
class CacheStore {

  /**
   * @param {Object} opts
   * @param {String} opts.dir root directory for cached content
   */
  constructor(opts = {}) {
    this.dir = opts.dir;
  }

  /**
   * @method _paths
   * @description compute the on-disk paths for a given cache key, sharded by
   * the first 4 hex characters of the key into a 2-level directory tree.
   *
   * @param {String} key cache key
   * @returns {Object} {shardDir, metaPath, bodyPath, tmpMetaPath, tmpBodyPath}
   */
  _paths(key) {
    let shardDir = path.join(this.dir, key.slice(0, 2), key.slice(2, 4));
    let unique = crypto.randomUUID();
    return {
      shardDir,
      metaPath: path.join(shardDir, `${key}.meta.json`),
      bodyPath: path.join(shardDir, `${key}.body`),
      tmpMetaPath: path.join(shardDir, `${key}.${unique}.meta.json.tmp`),
      tmpBodyPath: path.join(shardDir, `${key}.${unique}.body.tmp`)
    };
  }

  /**
   * @method readEntry
   * @description read a cache entry's metadata from disk, if present.
   *
   * @param {String} key cache key
   * @returns {Object|null} {status, headers, createdAt, expiresAt, size, bodyPath}, or null if not present
   */
  readEntry(key) {
    let p = this._paths(key);
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(p.metaPath, 'utf8'));
    } catch (e) {
      return null;
    }
    return { ...meta, bodyPath: p.bodyPath };
  }

  /**
   * @method deleteEntry
   * @description remove a cache entry's files from disk, ignoring errors
   * (e.g. already absent).
   *
   * @param {String} key cache key
   * @returns {void}
   */
  deleteEntry(key) {
    let p = this._paths(key);
    try { fs.unlinkSync(p.metaPath); } catch (e) { /* already gone */ }
    try { fs.unlinkSync(p.bodyPath); } catch (e) { /* already gone */ }
  }

  /**
   * @method createWriteSink
   * @description open a streaming write sink for a new cache entry. Bytes
   * are written to a tmp file as they arrive; finish() atomically renames
   * both the body and metadata into place, and abort() discards everything
   * written so far.
   *
   * @param {String} key cache key
   * @returns {Object} {write(chunk), finish(meta), abort()}
   */
  createWriteSink(key) {
    let p = this._paths(key);
    fs.mkdirSync(p.shardDir, { recursive: true });

    let size = 0;
    let settled = false;
    let stream = fs.createWriteStream(p.tmpBodyPath);
    stream.on('error', () => { settled = true; });

    return {
      get size() { return size; },

      /**
       * @method write
       * @description write a chunk of response body bytes to the tmp file.
       *
       * @param {Buffer} chunk
       * @returns {Number} cumulative bytes written so far
       */
      write(chunk) {
        if (settled) return size;
        size += chunk.length;
        stream.write(chunk);
        return size;
      },

      /**
       * @method finish
       * @description finalize the entry: close the body file, write and
       * rename the metadata file into place, then rename the body into
       * place.
       *
       * @param {Object} meta {status, headers, createdAt, expiresAt}
       * @returns {Promise<Object>} {size}
       */
      finish(meta) {
        return new Promise((resolve, reject) => {
          if (settled) return reject(new Error('cache write sink already aborted/errored'));
          settled = true;
          stream.end(() => {
            try {
              fs.renameSync(p.tmpBodyPath, p.bodyPath);
              fs.writeFileSync(p.tmpMetaPath, JSON.stringify({ ...meta, size }));
              fs.renameSync(p.tmpMetaPath, p.metaPath);
              resolve({ size });
            } catch (e) {
              reject(e);
            }
          });
        });
      },

      /**
       * @method abort
       * @description discard this write attempt, cleaning up tmp files.
       *
       * @returns {void}
       */
      abort() {
        if (settled) return;
        settled = true;
        stream.destroy();
        try { fs.unlinkSync(p.tmpBodyPath); } catch (e) { /* never created or already gone */ }
        try { fs.unlinkSync(p.tmpMetaPath); } catch (e) { /* never created or already gone */ }
      }
    };
  }
}

export { CacheStore };
