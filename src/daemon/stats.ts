/**
 * Rolling window cache statistics tracking.
 *
 * Tracks cache hits and misses with a rolling window for hit rate calculation.
 * The rolling window provides insight into recent cache performance while
 * total counters track all-time statistics.
 *
 * @module daemon/stats
 */

// ============================================================================
// Constants
// ============================================================================

/** Maximum number of queries tracked in the rolling window */
const ROLLING_WINDOW = 100

// ============================================================================
// Types
// ============================================================================

/**
 * State for tracking cache statistics.
 *
 * Uses a circular buffer for O(1) rolling window updates instead of
 * array shift operations which would be O(n).
 */
export interface StatsState {
  /** Total number of cache hits (all-time) */
  hits: number
  /** Total number of cache misses (all-time) */
  misses: number
  /** Circular buffer for rolling window (true = hit, false = miss) */
  ringBuffer: boolean[]
  /** Next write position in circular buffer (0 to ROLLING_WINDOW-1) */
  ringIndex: number
  /** Number of entries in the buffer (0 to ROLLING_WINDOW) */
  ringCount: number
  /** Running count of hits in the current window for O(1) hit rate calculation */
  windowHits: number
}

// ============================================================================
// State Factory
// ============================================================================

/**
 * Creates a new stats state with zeroed counters.
 *
 * @returns Fresh stats state
 *
 * @example
 * ```ts
 * const stats = createStatsState();
 * recordCacheHit(stats);
 * console.log(getCacheHitRate(stats)); // 1
 * ```
 */
export function createStatsState(): StatsState {
  return {
    hits: 0,
    misses: 0,
    ringBuffer: new Array(ROLLING_WINDOW),
    ringIndex: 0,
    ringCount: 0,
    windowHits: 0,
  }
}

// ============================================================================
// Recording Functions
// ============================================================================

/**
 * Records a cache hit.
 *
 * Increments the hit counter and adds to the rolling window.
 * Uses a circular buffer for O(1) updates.
 *
 * @param stats - Stats state to mutate
 */
export function recordCacheHit(stats: StatsState): void {
  stats.hits++

  // If buffer is full, subtract the outgoing value from window hits
  if (stats.ringCount === ROLLING_WINDOW) {
    if (stats.ringBuffer[stats.ringIndex]) {
      stats.windowHits--
    }
  } else {
    stats.ringCount++
  }

  // Write the new value and update window hits
  stats.ringBuffer[stats.ringIndex] = true
  stats.windowHits++

  // Advance the circular index
  stats.ringIndex = (stats.ringIndex + 1) % ROLLING_WINDOW
}

/**
 * Records a cache miss.
 *
 * Increments the miss counter and adds to the rolling window.
 * Uses a circular buffer for O(1) updates.
 *
 * @param stats - Stats state to mutate
 */
export function recordCacheMiss(stats: StatsState): void {
  stats.misses++

  // If buffer is full, subtract the outgoing value from window hits
  if (stats.ringCount === ROLLING_WINDOW) {
    if (stats.ringBuffer[stats.ringIndex]) {
      stats.windowHits--
    }
  } else {
    stats.ringCount++
  }

  // Write the new value (false = miss, doesn't add to windowHits)
  stats.ringBuffer[stats.ringIndex] = false

  // Advance the circular index
  stats.ringIndex = (stats.ringIndex + 1) % ROLLING_WINDOW
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * Calculates the cache hit rate from the rolling window.
 *
 * Returns the ratio of hits to total queries in the recent window.
 * Returns 0 if no queries have been recorded.
 * Uses pre-computed windowHits for O(1) calculation.
 *
 * @param stats - Stats state to read from
 * @returns Hit rate between 0 and 1
 */
export function getCacheHitRate(stats: StatsState): number {
  if (stats.ringCount === 0) {
    return 0
  }
  return stats.windowHits / stats.ringCount
}

/**
 * Returns the total number of queries (hits + misses) all-time.
 *
 * @param stats - Stats state to read from
 * @returns Total query count
 */
export function getTotalQueries(stats: StatsState): number {
  return stats.hits + stats.misses
}

// ============================================================================
// Mutation Functions
// ============================================================================

/**
 * Resets all stats to initial values.
 *
 * Clears hit/miss counters and the rolling window.
 *
 * @param stats - Stats state to reset
 */
export function resetStats(stats: StatsState): void {
  stats.hits = 0
  stats.misses = 0
  stats.ringBuffer = new Array(ROLLING_WINDOW)
  stats.ringIndex = 0
  stats.ringCount = 0
  stats.windowHits = 0
}
