/**
 * Oracle-health loader: the one place that turns (network, days) into the
 * oracle-health dataset behind GET /api/analytics/oracle-health.
 *
 * The underlying scan (VerdiktaService.getOracleHealth) is ~65 archive
 * eth_getLogs calls for a 14-day window — several seconds cold, and the
 * page fires it for two windows on every visit. Almost all of that data is
 * immutable history, so this module makes sure visitors never wait on it:
 *
 *   - Stale-while-revalidate: an expired cache entry is served immediately
 *     and ONE rescan is started in the background to replace it.
 *   - In-flight dedupe: concurrent requests for the same key (two browsers,
 *     or the warmer racing a visitor) share a single scan promise.
 *   - Background warmer: a timer refreshes every network × window the page
 *     uses, so the cache is warm before anyone asks. Disable with
 *     ORACLE_HEALTH_WARM_INTERVAL_MS=0 (e.g. in a dev shell).
 *
 * Tunables (env, all optional):
 *   ORACLE_HEALTH_TTL_MS            freshness window, default 10 min. Must be
 *                                   ≥ the warm interval or entries go stale
 *                                   between warms.
 *   ORACLE_HEALTH_WARM_INTERVAL_MS  warmer period, default 5 min; 0 disables.
 */

const logger = require('./logger');
const { analyticsCache } = require('./analyticsCacheService');
const { getVerdiktaService } = require('./verdiktaService');
const { networks } = require('../config');

const envMs = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

const TTL_MS = envMs('ORACLE_HEALTH_TTL_MS', 10 * 60 * 1000);
const WARM_INTERVAL_MS = envMs('ORACLE_HEALTH_WARM_INTERVAL_MS', 5 * 60 * 1000);
// The windows the Analytics page requests (14-day tables + 24-hour table).
const WARM_WINDOWS = [14, 1];
// Wait for the process to settle (RPC providers resolved, first page hits
// answered) before the boot warm starts competing for the RPC budget.
const BOOT_WARM_DELAY_MS = 5 * 1000;

const cacheKey = (network, days) => `analytics_oracle_health_${network}_${days}`;

/** key → in-flight scan promise, so concurrent callers share one scan. */
const inflight = new Map();

/**
 * Run the scan for (network, days) and store the result. Deduped: while a
 * scan for the same key is running, callers get that same promise.
 */
function refresh(network, days) {
  const key = cacheKey(network, days);
  const running = inflight.get(key);
  if (running) return running;

  const started = Date.now();
  const p = (async () => {
    const data = await getVerdiktaService(network).getOracleHealth({ days });
    analyticsCache.set(key, data, TTL_MS);
    logger.info('oracle-health: scan complete', { key, ms: Date.now() - started });
    return data;
  })().finally(() => {
    inflight.delete(key);
  });
  inflight.set(key, p);
  return p;
}

/**
 * Resolve the dataset for a request.
 *  - fresh cache  → served as-is
 *  - stale cache  → served as-is, background refresh kicked off (if not running)
 *  - no cache     → awaits the (shared) scan
 * @returns {Promise<{data, cached, stale, refreshing, cachedAt?}>}
 */
async function load(network, days) {
  const key = cacheKey(network, days);
  const entry = analyticsCache.getStale(key);
  if (entry) {
    let refreshing = inflight.has(key);
    if (entry.stale && !refreshing) {
      refreshing = true;
      refresh(network, days).catch((err) => {
        // Keep serving the stale copy; the next request (or the warmer) retries.
        logger.warn('oracle-health: background refresh failed', { key, msg: err.message });
      });
    }
    return { data: entry.data, cached: true, stale: entry.stale, refreshing, cachedAt: entry.timestamp };
  }
  const data = await refresh(network, days);
  return { data, cached: false, stale: false, refreshing: false };
}

/**
 * Refresh every warmed key once, sequentially — the scans share one RPC
 * budget, and running them one at a time keeps a visitor's own request from
 * being starved. Failures are logged per key and never abort the sweep.
 */
async function warmAll() {
  const started = Date.now();
  for (const network of Object.keys(networks)) {
    for (const days of WARM_WINDOWS) {
      try {
        await refresh(network, days);
      } catch (err) {
        logger.warn('oracle-health: warm failed', { key: cacheKey(network, days), msg: err.message });
      }
    }
  }
  logger.info('oracle-health: warm sweep done', { ms: Date.now() - started });
}

let warmTimer = null;

/**
 * Start the background warmer. Idempotent. Returns false when disabled.
 */
function startWarmer() {
  if (warmTimer || WARM_INTERVAL_MS === 0) {
    if (WARM_INTERVAL_MS === 0) logger.info('oracle-health: warmer disabled (ORACLE_HEALTH_WARM_INTERVAL_MS=0)');
    return false;
  }
  if (TTL_MS < WARM_INTERVAL_MS) {
    logger.warn('oracle-health: TTL is shorter than the warm interval — entries will go stale between warms', {
      ttlMs: TTL_MS, warmIntervalMs: WARM_INTERVAL_MS,
    });
  }
  logger.info('oracle-health: warmer started', {
    intervalMs: WARM_INTERVAL_MS, ttlMs: TTL_MS,
    networks: Object.keys(networks), windows: WARM_WINDOWS,
  });
  // Sweeps are serialized: a slow sweep is never overlapped by the next tick.
  let sweeping = false;
  const tick = async () => {
    if (sweeping) return;
    sweeping = true;
    try { await warmAll(); } finally { sweeping = false; }
  };
  setTimeout(tick, BOOT_WARM_DELAY_MS).unref();
  warmTimer = setInterval(tick, WARM_INTERVAL_MS);
  warmTimer.unref();
  return true;
}

function stopWarmer() {
  if (warmTimer) { clearInterval(warmTimer); warmTimer = null; }
}

module.exports = { load, refresh, warmAll, startWarmer, stopWarmer, cacheKey, TTL_MS, WARM_INTERVAL_MS, WARM_WINDOWS };
