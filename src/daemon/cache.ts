/**
 * Daemon caching utilities for fast query responses.
 *
 * This module provides:
 * - TTLCache: Time-based result caching with LRU eviction
 * - PrefixCache: Incremental search optimization for query extensions
 *
 * @module daemon/cache
 */

import type { DaemonSearchResult } from "./protocol";

// ============================================================================
// TTL Cache Types
// ============================================================================

/**
 * Cache entry with results and timestamp for TTL tracking.
 */
export interface CacheEntry {
	/** Cached search results */
	readonly results: DaemonSearchResult[];
	/** Timestamp when entry was created (ms since epoch) */
	readonly timestamp: number;
}

/**
 * Configuration for TTLCache.
 */
export interface CacheConfig {
	/** Time-to-live in milliseconds */
	readonly ttlMs: number;
	/** Maximum number of entries before LRU eviction */
	readonly maxEntries: number;
}

// ============================================================================
// TTL Cache Implementation
// ============================================================================

/**
 * Time-based cache with LRU eviction for search results.
 *
 * Entries expire after TTL and oldest entries are evicted
 * when maxEntries is reached.
 */
export class TTLCache {
	private readonly entries = new Map<string, CacheEntry>();
	private readonly ttlMs: number;
	private readonly maxEntries: number;

	constructor(config: CacheConfig) {
		this.ttlMs = config.ttlMs;
		this.maxEntries = config.maxEntries;
	}

	/**
	 * Creates a cache key from search parameters.
	 *
	 * @param generation - Index generation number
	 * @param cwd - Working directory
	 * @param query - Search query string
	 * @param limit - Result limit
	 * @returns Cache key string
	 */
	static makeKey(generation: number, cwd: string, query: string, limit: number): string {
		return `${generation}:${cwd}:${query}:${limit}`;
	}

	/**
	 * Gets cached results if not expired.
	 *
	 * @param key - Cache key
	 * @returns Cached results or undefined if missing/expired
	 */
	get(key: string): DaemonSearchResult[] | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;

		const now = Date.now();
		if (now - entry.timestamp > this.ttlMs) {
			this.entries.delete(key);
			return undefined;
		}

		return entry.results;
	}

	/**
	 * Stores results in the cache.
	 *
	 * Evicts oldest entry if at capacity.
	 *
	 * @param key - Cache key
	 * @param results - Search results to cache
	 */
	set(key: string, results: DaemonSearchResult[]): void {
		// Evict oldest if at capacity
		if (this.entries.size >= this.maxEntries && !this.entries.has(key)) {
			const oldestKey = this.entries.keys().next().value;
			if (oldestKey) {
				this.entries.delete(oldestKey);
			}
		}

		this.entries.set(key, {
			results,
			timestamp: Date.now(),
		});
	}

	/**
	 * Clears all entries from the cache.
	 */
	clear(): void {
		this.entries.clear();
	}

	/**
	 * Removes expired entries from the cache.
	 *
	 * @returns Number of entries pruned
	 */
	prune(): number {
		const now = Date.now();
		let pruned = 0;

		for (const [key, entry] of this.entries) {
			if (now - entry.timestamp > this.ttlMs) {
				this.entries.delete(key);
				pruned++;
			}
		}

		return pruned;
	}

	/**
	 * Gets the number of entries in the cache.
	 */
	get size(): number {
		return this.entries.size;
	}
}

// ============================================================================
// Prefix Cache Types
// ============================================================================

/**
 * Prefix cache entry storing query context and results.
 */
export interface PrefixEntry {
	/** Original query string */
	readonly query: string;
	/** Working directory for the query */
	readonly cwd: string;
	/** Cached search results */
	readonly results: DaemonSearchResult[];
	/** Timestamp when entry was created */
	readonly timestamp: number;
}

/**
 * Configuration for PrefixCache.
 */
export interface PrefixCacheConfig {
	/** Time-to-live in milliseconds (default: 30000) */
	readonly ttlMs: number;
}

// ============================================================================
// Prefix Cache Implementation
// ============================================================================

/**
 * Cache for incremental search optimization.
 *
 * When a query extends a previously cached query (e.g., "but" -> "butt"),
 * results can be filtered locally without hitting the database.
 *
 * @example
 * ```ts
 * cache.store("but", "/root", results);
 * // Later, when user types "butt":
 * const filtered = cache.tryFilter("butt", "/root", r => r.path.includes("butt"));
 * if (filtered) {
 *   // Use filtered results instead of querying database
 * }
 * ```
 */
export class PrefixCache {
	private entry: PrefixEntry | undefined;
	private readonly ttlMs: number;

	constructor(config: PrefixCacheConfig = { ttlMs: 30000 }) {
		this.ttlMs = config.ttlMs;
	}

	/**
	 * Attempts to filter cached results for an extended query.
	 *
	 * @param query - Extended query string
	 * @param cwd - Working directory (must match cached entry)
	 * @param filterFn - Filter function to apply to results
	 * @returns Filtered results or undefined if cache miss
	 */
	tryFilter(
		query: string,
		cwd: string,
		filterFn: (result: DaemonSearchResult) => boolean
	): DaemonSearchResult[] | undefined {
		if (!this.entry) return undefined;

		// Check TTL expiration
		if (Date.now() - this.entry.timestamp > this.ttlMs) {
			this.entry = undefined;
			return undefined;
		}

		// Check cwd match
		if (this.entry.cwd !== cwd) return undefined;

		// Check if query extends cached query
		if (!query.startsWith(this.entry.query)) return undefined;

		// Filter and return results
		const filtered = this.entry.results.filter(filterFn);

		// Update cache with filtered results for chaining
		this.entry = {
			query,
			cwd,
			results: filtered,
			timestamp: this.entry.timestamp,
		};

		return filtered;
	}

	/**
	 * Stores results for future prefix extensions.
	 *
	 * @param query - Search query string
	 * @param cwd - Working directory
	 * @param results - Search results to cache
	 */
	store(query: string, cwd: string, results: DaemonSearchResult[]): void {
		this.entry = {
			query,
			cwd,
			results,
			timestamp: Date.now(),
		};
	}

	/**
	 * Clears the cached entry.
	 */
	clear(): void {
		this.entry = undefined;
	}

	/**
	 * Gets the currently cached query string.
	 */
	get currentQuery(): string | undefined {
		return this.entry?.query;
	}
}
