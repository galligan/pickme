/**
 * Daemon socket protocol types and Zod schemas.
 *
 * This module defines the communication protocol between pickme clients
 * and the daemon server using NDJSON over Unix sockets.
 *
 * @module daemon/protocol
 */

import { z } from 'zod'

// ============================================================================
// Result Type
// ============================================================================

/**
 * A discriminated union representing either success or failure.
 * Used for functional error handling without exceptions.
 */
export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

/**
 * Creates a successful Result.
 */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value }
}

/**
 * Creates a failed Result.
 */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error }
}

// ============================================================================
// Request Types
// ============================================================================

/**
 * Request to search for files matching a query.
 */
export interface SearchRequest {
  /** Unique request identifier */
  readonly id: string
  /** Request type discriminant */
  readonly type: 'search'
  /** Search query string */
  readonly query: string
  /** Working directory to search from (optional) */
  readonly cwd?: string
  /** Maximum number of results to return (default: 50) */
  readonly limit?: number
}

/**
 * Request to check daemon health status.
 */
export interface HealthRequest {
  /** Unique request identifier */
  readonly id: string
  /** Request type discriminant */
  readonly type: 'health'
}

/**
 * Request to invalidate cached data.
 */
export interface InvalidateRequest {
  /** Unique request identifier */
  readonly id: string
  /** Request type discriminant */
  readonly type: 'invalidate'
  /** Specific root to invalidate (optional, all roots if omitted) */
  readonly root?: string
}

/**
 * Request to stop the daemon.
 */
export interface StopRequest {
  /** Unique request identifier */
  readonly id: string
  /** Request type discriminant */
  readonly type: 'stop'
}

/**
 * Union of all daemon request types.
 */
export type DaemonRequest = SearchRequest | HealthRequest | InvalidateRequest | StopRequest

// ============================================================================
// Response Types
// ============================================================================

/**
 * A single search result from the daemon.
 */
export interface DaemonSearchResult {
  /** Absolute path to the file */
  readonly path: string
  /** Combined FTS + frecency score */
  readonly score: number
  /** Root directory this file belongs to */
  readonly root: string
}

/**
 * Health information about the daemon.
 */
export interface HealthInfo {
  /** Uptime in seconds */
  readonly uptime: number
  /** Resident set size in bytes */
  readonly rss: number
  /** Cache generation number (incremented on invalidation) */
  readonly generation: number
  /** Cache hit rate (0-1) */
  readonly cacheHitRate: number
  /** Number of active file watchers */
  readonly activeWatchers: number
  /** List of currently loaded root directories */
  readonly rootsLoaded: readonly string[]
}

/**
 * Response from the daemon.
 */
export interface DaemonResponse {
  /** Request ID this response corresponds to */
  readonly id: string
  /** Whether the request succeeded */
  readonly ok: boolean
  /** Error message if ok is false */
  readonly error?: string
  /** Search results (for search requests) */
  readonly results?: readonly DaemonSearchResult[]
  /** Whether results came from cache */
  readonly cached?: boolean
  /** Request duration in milliseconds */
  readonly durationMs?: number
  /** Health info (for health requests) */
  readonly health?: HealthInfo
}

// ============================================================================
// Zod Schemas
// ============================================================================

/**
 * Schema for search requests.
 */
export const SearchRequestSchema = z.object({
  id: z.string().min(1, 'id is required'),
  type: z.literal('search'),
  query: z.string().min(1, 'empty query').max(1000, 'query too long'),
  cwd: z.string().optional(),
  limit: z.number().int().positive().max(500).optional().default(50),
})

/**
 * Schema for health requests.
 */
export const HealthRequestSchema = z.object({
  id: z.string().min(1, 'id is required'),
  type: z.literal('health'),
})

/**
 * Schema for invalidate requests.
 */
export const InvalidateRequestSchema = z.object({
  id: z.string().min(1, 'id is required'),
  type: z.literal('invalidate'),
  root: z.string().optional(),
})

/**
 * Schema for stop requests.
 */
export const StopRequestSchema = z.object({
  id: z.string().min(1, 'id is required'),
  type: z.literal('stop'),
})

/**
 * Schema for all daemon requests (discriminated union on 'type').
 */
export const DaemonRequestSchema = z.discriminatedUnion('type', [
  SearchRequestSchema,
  HealthRequestSchema,
  InvalidateRequestSchema,
  StopRequestSchema,
])

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Generates a unique request ID using crypto.randomUUID().
 *
 * @returns A new UUID string
 */
export function generateRequestId(): string {
  return crypto.randomUUID()
}

/**
 * Parses a JSON line into a validated DaemonRequest.
 *
 * @param line - Raw JSON string to parse
 * @returns Result containing the parsed request or error message
 */
export function parseRequest(line: string): Result<DaemonRequest, string> {
  try {
    const json: unknown = JSON.parse(line)
    const result = DaemonRequestSchema.safeParse(json)
    if (!result.success) {
      // Extract first error message for cleaner error reporting
      // Zod 4.x uses .issues instead of .errors
      const firstIssue = result.error.issues[0]
      const message = firstIssue?.message ?? 'invalid request'
      return err(message)
    }
    return ok(result.data)
  } catch {
    return err('invalid JSON')
  }
}

/**
 * Formats a response as NDJSON (JSON followed by newline).
 *
 * @param response - Response to format
 * @returns JSON string with trailing newline
 */
export function formatResponse(response: DaemonResponse): string {
  return JSON.stringify(response) + '\n'
}

/**
 * Creates an error response.
 *
 * @param id - Request ID to respond to
 * @param error - Error message
 * @returns Error response object
 */
export function errorResponse(id: string, error: string): DaemonResponse {
  return { id, ok: false, error }
}

/**
 * Creates a success response with optional data.
 *
 * @param id - Request ID to respond to
 * @param data - Optional additional response data
 * @returns Success response object
 */
export function successResponse(
  id: string,
  data?: Omit<DaemonResponse, 'id' | 'ok'>
): DaemonResponse {
  return { id, ok: true, ...data }
}
