/**
 * Daemon client for communicating with the pickme daemon.
 *
 * Used by hooks to query the daemon for file suggestions,
 * with automatic fallback support when daemon is unavailable.
 *
 * @module daemon/client
 */

import { existsSync } from 'node:fs'
import { connect } from 'node:net'
import { generateRequestId, type DaemonSearchResult } from './protocol'

// ============================================================================
// Types
// ============================================================================

/**
 * Options for querying the daemon.
 */
export interface QueryOptions {
  /** The search query string */
  readonly query: string
  /** Working directory for the search */
  readonly cwd: string
  /** Maximum number of results (default: 50) */
  readonly limit?: number
}

/**
 * Response from a daemon query.
 */
export interface DaemonQueryResponse {
  /** Search results */
  readonly results: readonly DaemonSearchResult[]
  /** Whether results came from cache */
  readonly cached: boolean
  /** Query duration in milliseconds */
  readonly durationMs: number
}

// ============================================================================
// Client Functions
// ============================================================================

/**
 * Check if the daemon is running by attempting a health check.
 *
 * @param socketPath - Path to the daemon socket
 * @param timeoutMs - Timeout for health check (default: 500ms)
 * @returns true if daemon is healthy, false otherwise
 */
export async function isDaemonRunning(socketPath: string, timeoutMs = 500): Promise<boolean> {
  // Quick check: if socket file doesn't exist, daemon isn't running
  if (!existsSync(socketPath)) {
    return false
  }

  try {
    const response = await sendRequest(socketPath, { type: 'health' }, timeoutMs)
    return response.ok === true
  } catch {
    return false
  }
}

/**
 * Send a request to the daemon and parse the response.
 *
 * @param socketPath - Path to the daemon socket
 * @param request - Request object (will have id added)
 * @param timeoutMs - Request timeout (default: 5000ms)
 * @returns Parsed response object
 * @throws Error if connection fails or times out
 */
export async function sendRequest(
  socketPath: string,
  request: Record<string, unknown>,
  timeoutMs = 5000
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const fullRequest = { id: generateRequestId(), ...request }
    let data = ''
    let timedOut = false
    let settled = false

    // Create socket but don't connect yet - we need to attach handlers first
    const socket = connect({ path: socketPath })

    const timeout = setTimeout(() => {
      if (settled) return
      timedOut = true
      settled = true
      socket.destroy()
      reject(new Error('Daemon request timeout'))
    }, timeoutMs)

    socket.on('connect', () => {
      socket.write(JSON.stringify(fullRequest) + '\n')
    })

    socket.on('data', chunk => {
      data += chunk.toString()
    })

    socket.on('end', () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      try {
        const response = JSON.parse(data.trim()) as Record<string, unknown>
        resolve(response)
      } catch {
        reject(new Error('Invalid daemon response'))
      }
    })

    socket.on('error', err => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      reject(err)
    })
  })
}

/**
 * Query the daemon for file suggestions.
 *
 * @param socketPath - Path to the daemon socket
 * @param options - Query options
 * @returns Query response with results
 * @throws Error if query fails
 */
export async function queryDaemon(
  socketPath: string,
  options: QueryOptions
): Promise<DaemonQueryResponse> {
  const response = await sendRequest(socketPath, {
    type: 'search',
    query: options.query,
    cwd: options.cwd,
    limit: options.limit ?? 50,
  })

  if (!response.ok) {
    throw new Error((response.error as string) || 'Daemon query failed')
  }

  return {
    results: (response.results as DaemonSearchResult[]) || [],
    cached: response.cached as boolean,
    durationMs: response.durationMs as number,
  }
}
