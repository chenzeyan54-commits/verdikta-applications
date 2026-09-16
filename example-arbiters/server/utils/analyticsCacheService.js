/**
 * Analytics Cache Service
 * Simple in-memory cache with TTL for analytics data
 */

const logger = require('./logger');

class AnalyticsCacheService {
  constructor(ttlMs = 2 * 60 * 1000) { // 2 minutes default
    this.cache = new Map();
    this.ttlMs = ttlMs;
  }

  /** TTL that applies to an entry: its own override, else the cache default. */
  _ttlFor(entry) {
    return entry.ttlMs > 0 ? entry.ttlMs : this.ttlMs;
  }

  /**
   * Get cached data if valid
   * @param {string} key - Cache key
   * @returns {object|null} - Cached data or null if expired/missing
   */
  get(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }

    const age = Date.now() - entry.timestamp;
    if (age > this._ttlFor(entry)) {
      this.cache.delete(key);
      logger.info('Cache expired', { key, ageMs: age });
      return null;
    }

    logger.info('Cache hit', { key, ageMs: age });
    return {
      data: entry.data,
      timestamp: entry.timestamp,
      ageMs: age
    };
  }

  /**
   * Get a cached entry even if it has expired. Unlike get(), an expired entry
   * is NOT evicted — the caller is expected to serve it while a refresh runs
   * (stale-while-revalidate) and overwrite it via set().
   * @param {string} key - Cache key
   * @returns {object|null} - { data, timestamp, ageMs, stale } or null if missing
   */
  getStale(key) {
    const entry = this.cache.get(key);
    if (!entry) {
      return null;
    }
    const age = Date.now() - entry.timestamp;
    const stale = age > this._ttlFor(entry);
    logger.info(stale ? 'Cache stale' : 'Cache hit', { key, ageMs: age });
    return {
      data: entry.data,
      timestamp: entry.timestamp,
      ageMs: age,
      stale
    };
  }

  /**
   * Store data in cache
   * @param {string} key - Cache key
   * @param {object} data - Data to cache
   * @param {number} [ttlMs] - Per-entry TTL override (default: cache-wide TTL)
   */
  set(key, data, ttlMs) {
    const timestamp = Date.now();
    this.cache.set(key, { data, timestamp, ttlMs: ttlMs > 0 ? ttlMs : undefined });
    logger.info('Cache set', { key });
  }

  /**
   * Invalidate a cache entry
   * @param {string} key - Cache key to invalidate
   */
  invalidate(key) {
    this.cache.delete(key);
    logger.info('Cache invalidated', { key });
  }

  /**
   * Clear all cache entries
   */
  clear() {
    this.cache.clear();
    logger.info('Cache cleared');
  }

  /**
   * Get cache statistics
   * @returns {object} - Cache stats
   */
  getStats() {
    return {
      size: this.cache.size,
      ttlMs: this.ttlMs,
      keys: Array.from(this.cache.keys())
    };
  }
}

// Singleton instance
const analyticsCache = new AnalyticsCacheService();

module.exports = {
  analyticsCache,
  AnalyticsCacheService
};
