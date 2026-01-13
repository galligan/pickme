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
const ROLLING_WINDOW = 100;

// ============================================================================
// Types
// ============================================================================

/**
 * State for tracking cache statistics.
 */
export interface StatsState {
	/** Total number of cache hits (all-time) */
	hits: number;
	/** Total number of cache misses (all-time) */
	misses: number;
	/** Recent query results for rolling window hit rate (true = hit, false = miss) */
	recentQueries: boolean[];
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
		recentQueries: [],
	};
}

// ============================================================================
// Recording Functions
// ============================================================================

/**
 * Records a cache hit.
 *
 * Increments the hit counter and adds to the rolling window.
 * If the rolling window exceeds ROLLING_WINDOW entries, the oldest entry is removed.
 *
 * @param stats - Stats state to mutate
 */
export function recordCacheHit(stats: StatsState): void {
	stats.hits++;
	stats.recentQueries.push(true);
	if (stats.recentQueries.length > ROLLING_WINDOW) {
		stats.recentQueries.shift();
	}
}

/**
 * Records a cache miss.
 *
 * Increments the miss counter and adds to the rolling window.
 * If the rolling window exceeds ROLLING_WINDOW entries, the oldest entry is removed.
 *
 * @param stats - Stats state to mutate
 */
export function recordCacheMiss(stats: StatsState): void {
	stats.misses++;
	stats.recentQueries.push(false);
	if (stats.recentQueries.length > ROLLING_WINDOW) {
		stats.recentQueries.shift();
	}
}

// ============================================================================
// Query Functions
// ============================================================================

/**
 * Calculates the cache hit rate from the rolling window.
 *
 * Returns the ratio of hits to total queries in the recent window.
 * Returns 0 if no queries have been recorded.
 *
 * @param stats - Stats state to read from
 * @returns Hit rate between 0 and 1
 */
export function getCacheHitRate(stats: StatsState): number {
	if (stats.recentQueries.length === 0) {
		return 0;
	}
	const hits = stats.recentQueries.filter(Boolean).length;
	return hits / stats.recentQueries.length;
}

/**
 * Returns the total number of queries (hits + misses) all-time.
 *
 * @param stats - Stats state to read from
 * @returns Total query count
 */
export function getTotalQueries(stats: StatsState): number {
	return stats.hits + stats.misses;
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
	stats.hits = 0;
	stats.misses = 0;
	stats.recentQueries = [];
}
