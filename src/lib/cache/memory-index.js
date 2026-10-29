/**
 * @class MemoryIndex
 * @description in-memory, per-instance index of what's on disk, and the sole
 * source of truth for hit/miss/TTL/eviction decisions - disk is written
 * through but never read to answer a hit/miss question. Tracks a running
 * total size and evicts least-recently-used entries synchronously whenever a
 * write pushes the total over budget.
 */
class MemoryIndex {

  /**
   * @param {Object} opts
   * @param {Number} opts.maxSizeBytes total cache size budget
   * @param {Function} [opts.onEvict] called with (key) whenever an entry is
   * removed from the index, so the caller can also delete it from disk
   */
  constructor(opts = {}) {
    this.maxSizeBytes = opts.maxSizeBytes;
    this.onEvict = opts.onEvict || (() => {});
    this.map = new Map();
    this.totalSizeBytes = 0;
  }

  /**
   * @method get
   * @description look up an entry by key, evicting it (as an expiry, not a
   * size eviction) if its TTL has passed. Touches lastAccessedAt on a hit.
   *
   * @param {String} key cache key
   * @returns {Object|null} {key, sizeBytes, expiresAt, lastAccessedAt}, or null on miss/expiry
   */
  get(key) {
    let entry = this.map.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expiresAt) {
      this.delete(key);
      return null;
    }

    entry.lastAccessedAt = Date.now();
    return entry;
  }

  /**
   * @method set
   * @description insert or replace an entry, then evict least-recently-used
   * entries (if needed) to stay within maxSizeBytes.
   *
   * @param {Object} entry {key, sizeBytes, expiresAt}
   * @returns {void}
   */
  set(entry) {
    let existing = this.map.get(entry.key);
    if (existing) this.totalSizeBytes -= existing.sizeBytes;

    entry.lastAccessedAt = Date.now();
    this.map.set(entry.key, entry);
    this.totalSizeBytes += entry.sizeBytes;

    this._evictToFit();
  }

  /**
   * @method delete
   * @description remove an entry from the index (if present) and notify
   * onEvict so the caller can remove it from disk too.
   *
   * @param {String} key cache key
   * @returns {void}
   */
  delete(key) {
    let entry = this.map.get(key);
    if (!entry) return;
    this.map.delete(key);
    this.totalSizeBytes -= entry.sizeBytes;
    this.onEvict(key);
  }

  /**
   * @method _evictToFit
   * @description evict least-recently-used entries until totalSizeBytes is
   * back within budget.
   *
   * @returns {void}
   */
  _evictToFit() {
    if (this.totalSizeBytes <= this.maxSizeBytes) return;

    let entries = [...this.map.values()].sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);
    for (let entry of entries) {
      if (this.totalSizeBytes <= this.maxSizeBytes) break;
      this.delete(entry.key);
    }
  }

  /**
   * @method sweep
   * @description background pass: evict anything past its TTL regardless of
   * whether it's been looked up since expiring, then re-verify the size
   * budget as a safety net.
   *
   * @returns {void}
   */
  sweep() {
    let now = Date.now();
    for (let entry of [...this.map.values()]) {
      if (now > entry.expiresAt) this.delete(entry.key);
    }
    this._evictToFit();
  }
}

export { MemoryIndex };
