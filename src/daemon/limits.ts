/**
 * Query limit calculation for early cutoff.
 *
 * Short queries match many files but users rarely scroll past
 * the first few results while still typing. Limiting early
 * reduces SQLite work and cache memory.
 *
 * @module daemon/limits
 */

// ============================================================================
// Constants
// ============================================================================

/** Default maximum limit for any query */
export const DEFAULT_MAX_LIMIT = 50

// ============================================================================
// Limit Calculation
// ============================================================================

/**
 * Calculate the effective result limit based on query length.
 *
 * Concrete limits based on query length:
 * - 1-2 chars: limit 10 results (very incomplete, fast response)
 * - 3-4 chars: limit 25 results (getting more specific)
 * - 5+ chars: limit 50 results (or user-configured max)
 *
 * @param queryLength - Length of the searchable portion of the query
 * @param requestedLimit - User-requested limit (optional)
 * @param maxLimit - Maximum allowed limit (default: 50)
 * @returns The effective limit to use
 */
export function getEffectiveLimit(
  queryLength: number,
  requestedLimit?: number,
  maxLimit = DEFAULT_MAX_LIMIT
): number {
  const baseLimit = getBaseLimit(queryLength)

  if (requestedLimit === undefined) {
    return Math.min(baseLimit, maxLimit)
  }

  // User requested limit is capped by both base and max
  return Math.min(requestedLimit, baseLimit, maxLimit)
}

/**
 * Get the base limit for a given query length.
 */
function getBaseLimit(queryLength: number): number {
  if (queryLength <= 2) return 10
  if (queryLength <= 4) return 25
  return 50
}

/**
 * Extract the searchable portion of a query (ignoring namespace prefix).
 *
 * @example
 * getSearchableLength("readme") // 6
 * getSearchableLength("@docs:readme") // 6 (just "readme")
 * getSearchableLength("@:test") // 4 (just "test")
 *
 * @param query - The full query string
 * @returns Length of the searchable portion
 */
export function getSearchableLength(query: string): number {
  // Strip namespace prefix if present (@namespace:query or @:query)
  const match = query.match(/^@[^:]*:(.*)/)
  const searchPart = match ? match[1] : query
  return searchPart.trim().length
}
