/**
 * Daemon request handlers.
 *
 * Wires daemon protocol requests to the FilePicker implementation,
 * providing search, health, invalidation, and stop functionality.
 *
 * @module daemon/handlers
 */

import type { FilePicker, FilePickerSearchResult } from '../index'
import { getEffectiveLimit, getSearchableLength } from './limits'
import {
  type DaemonRequest,
  type DaemonResponse,
  type DaemonSearchResult,
  successResponse,
  errorResponse,
} from './protocol'

// ============================================================================
// Daemon State
// ============================================================================

/**
 * Mutable state tracked by the daemon across requests.
 */
export interface DaemonState {
  /** Timestamp when the daemon started (ms since epoch) */
  startTime: number
  /** Cache generation number (incremented on invalidation) */
  generation: number
  /** Number of cache hits */
  cacheHits: number
  /** Total number of cache lookups */
  cacheTotal: number
}

/**
 * Creates the initial daemon state.
 *
 * @returns Fresh daemon state with current timestamp
 */
export function createInitialState(): DaemonState {
  return {
    startTime: Date.now(),
    generation: 0,
    cacheHits: 0,
    cacheTotal: 0,
  }
}

// ============================================================================
// Request Handler
// ============================================================================

/**
 * Handles a daemon request and returns the appropriate response.
 *
 * Uses an exhaustive switch on request type to ensure all request
 * types are handled at compile time.
 *
 * @param request - The validated daemon request
 * @param state - Mutable daemon state
 * @param picker - FilePicker instance for search operations
 * @returns Response to send back to the client
 */
export async function handleRequest(
  request: DaemonRequest,
  state: DaemonState,
  picker: FilePicker
): Promise<DaemonResponse> {
  switch (request.type) {
    case 'search':
      return handleSearch(request, state, picker)
    case 'health':
      return handleHealth(request, state)
    case 'invalidate':
      return handleInvalidate(request, state)
    case 'stop':
      return handleStop(request, state)
  }
  // TypeScript exhaustiveness check - this line is unreachable if all cases handled
  // If a new request type is added to the union, TypeScript will error here
}

// ============================================================================
// Individual Handlers
// ============================================================================

/**
 * Handles a search request by delegating to FilePicker.search().
 *
 * @param request - Search request with query, cwd, and limit
 * @param state - Daemon state (unused in foundation, used for caching later)
 * @param picker - FilePicker instance to perform the search
 * @returns Response with search results and timing info
 */
async function handleSearch(
  request: Extract<DaemonRequest, { type: 'search' }>,
  state: DaemonState,
  picker: FilePicker
): Promise<DaemonResponse> {
  const start = performance.now()

  try {
    // Calculate effective limit based on query length
    const queryLength = getSearchableLength(request.query)
    const limit = getEffectiveLimit(queryLength, request.limit)

    // Delegate to FilePicker.search with request parameters
    const matches = await picker.search(request.query, {
      projectRoot: request.cwd,
      limit,
    })

    // Transform FilePickerSearchResult to DaemonSearchResult
    const results: DaemonSearchResult[] = matches.map((match: FilePickerSearchResult) => ({
      path: match.path,
      score: match.score,
      // Use relativePath as root hint, or extract from path
      root: extractRoot(match.path, request.cwd),
    }))

    const durationMs = roundTo2Decimals(performance.now() - start)

    return successResponse(request.id, {
      results,
      cached: false, // Caching added in later phase
      durationMs,
    })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'search failed'
    return errorResponse(request.id, message)
  }
}

/**
 * Handles a health request by returning daemon metrics.
 *
 * @param request - Health request
 * @param state - Daemon state with timing and cache info
 * @returns Response with health metrics
 */
function handleHealth(
  request: Extract<DaemonRequest, { type: 'health' }>,
  state: DaemonState
): DaemonResponse {
  const uptime = Math.floor((Date.now() - state.startTime) / 1000)
  const rss = process.memoryUsage().rss
  const cacheHitRate = state.cacheTotal > 0 ? state.cacheHits / state.cacheTotal : 0

  return successResponse(request.id, {
    health: {
      uptime,
      rss,
      generation: state.generation,
      cacheHitRate,
      activeWatchers: 0, // Added in later phase
      rootsLoaded: [], // Added in later phase
    },
  })
}

/**
 * Handles an invalidate request by bumping the cache generation.
 *
 * In later phases, this will also clear cached data.
 *
 * @param request - Invalidate request with optional root filter
 * @param state - Daemon state to mutate
 * @returns Success response
 */
function handleInvalidate(
  request: Extract<DaemonRequest, { type: 'invalidate' }>,
  state: DaemonState
): DaemonResponse {
  // Bump generation to invalidate future cache keys
  state.generation++

  // Actual cache clearing added in later phase
  // request.root can be used to selectively invalidate

  return successResponse(request.id)
}

/**
 * Handles a stop request.
 *
 * In later phases, this will trigger graceful shutdown.
 * For now, it's a placeholder that returns success.
 *
 * @param request - Stop request
 * @param state - Daemon state (unused)
 * @returns Success response
 */
function handleStop(
  request: Extract<DaemonRequest, { type: 'stop' }>,
  _state: DaemonState
): DaemonResponse {
  // Actual shutdown logic added in later phase
  // The server layer will handle the actual shutdown

  return successResponse(request.id)
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Extracts the root directory from a file path.
 *
 * If cwd is provided and the path is under it, returns cwd.
 * Otherwise, attempts to extract a reasonable root from the path.
 *
 * @param filePath - Absolute file path
 * @param cwd - Optional working directory
 * @returns Root directory path
 */
function extractRoot(filePath: string, cwd?: string): string {
  if (cwd && filePath.startsWith(cwd)) {
    return cwd
  }
  // Fall back to parent directory as a simple heuristic
  // In later phases, this will use the actual indexed root
  const lastSlash = filePath.lastIndexOf('/')
  if (lastSlash > 0) {
    return filePath.slice(0, lastSlash)
  }
  return ''
}

/**
 * Rounds a number to 2 decimal places.
 *
 * @param value - Number to round
 * @returns Rounded value
 */
function roundTo2Decimals(value: number): number {
  return Math.round(value * 100) / 100
}
