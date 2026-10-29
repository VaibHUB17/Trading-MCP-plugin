/**
 * In-memory TTL (Time-To-Live) cache
 * - Per-entry expiry
 * - LRU eviction once maxEntries is reached (bounded memory)
 * - Request coalescing: concurrent misses for the same key share one upstream call
 * - Stale-on-error: if upstream fails, the last known value is served (flagged stale)
 */

class Cache {
  constructor({ maxEntries = 2000, staleGraceSec = 3600 } = {}) {
    this.store = new Map();
    this.inflight = new Map();
    this.maxEntries = maxEntries;
    this.staleGraceMs = staleGraceSec * 1000;
    this.stats = { hits: 0, misses: 0, coalesced: 0, staleServed: 0, evictions: 0 };
  }

  /**
   * Set a cache entry with TTL
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttl - Time to live in seconds
   */
  set(key, value, ttl) {
    // Re-insert so Map order reflects recency (LRU)
    this.store.delete(key);
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });

    while (this.store.size > this.maxEntries) {
      this.store.delete(this.store.keys().next().value);
      this.stats.evictions++;
    }
  }

  /**
   * Get a fresh cache entry
   * @param {string} key - Cache key
   * @returns {any|null} - Cached value or null if expired/not found
   */
  get(key) {
    const entry = this.store.get(key);
    if (!entry || Date.now() > entry.expiresAt) return null;

    // Touch for LRU
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  /**
   * Get an entry even if expired, as long as it is within the stale grace window
   */
  getStale(key) {
    const entry = this.store.get(key);
    if (!entry || Date.now() > entry.expiresAt + this.staleGraceMs) return null;
    return entry.value;
  }

  /**
   * Return cached value or compute it once. Concurrent callers for the same key
   * await the same promise instead of each hitting the upstream API.
   * @param {string} key - Cache key
   * @param {number|function} ttl - TTL in seconds, or fn(value) => seconds
   * @param {function} loader - async () => value
   */
  async getOrSet(key, ttl, loader) {
    const cached = this.get(key);
    if (cached !== null) {
      this.stats.hits++;
      return cached;
    }

    const pending = this.inflight.get(key);
    if (pending) {
      this.stats.coalesced++;
      return pending;
    }

    this.stats.misses++;
    const promise = (async () => {
      try {
        const value = await loader();
        this.set(key, value, typeof ttl === 'function' ? ttl(value) : ttl);
        return value;
      } catch (error) {
        const stale = this.getStale(key);
        if (stale !== null) {
          this.stats.staleServed++;
          console.error(`[cache] serving stale ${key}: ${error.message}`);
          return stale;
        }
        throw error;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  /**
   * Check if key exists and is not expired
   */
  has(key) {
    return this.get(key) !== null;
  }

  delete(key) {
    this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  /**
   * Remove entries that are past their stale grace window
   */
  cleanup() {
    const cutoff = Date.now() - this.staleGraceMs;
    for (const [key, entry] of this.store.entries()) {
      if (entry.expiresAt < cutoff) {
        this.store.delete(key);
      }
    }
  }

  /**
   * Get cache statistics
   */
  getStats() {
    const now = Date.now();
    let valid = 0;
    for (const entry of this.store.values()) {
      if (now <= entry.expiresAt) valid++;
    }
    const lookups = this.stats.hits + this.stats.misses + this.stats.coalesced;

    return {
      total: this.store.size,
      valid,
      expired: this.store.size - valid,
      inflight: this.inflight.size,
      ...this.stats,
      hitRate: lookups > 0 ? +((this.stats.hits + this.stats.coalesced) / lookups).toFixed(3) : 0,
    };
  }
}

// Create singleton cache instance
const cache = new Cache();

// Clean up expired entries every 5 minutes; unref so it never keeps the process alive
setInterval(() => cache.cleanup(), 5 * 60 * 1000).unref();

export default cache;
