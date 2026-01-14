/**
 * Unix socket server for the pickme daemon.
 *
 * Provides a Bun-based server that listens on a Unix socket,
 * accepts NDJSON requests, and sends NDJSON responses.
 *
 * @module daemon/server
 */

import { existsSync, unlinkSync } from 'node:fs'
import {
  parseRequest,
  formatResponse,
  errorResponse,
  type DaemonRequest,
  type DaemonResponse,
} from './protocol'
import { getSocketPath, ensureSocketDir } from './socket-path'

// ============================================================================
// Types
// ============================================================================

/**
 * Handler function that processes daemon requests.
 */
export type RequestHandler = (request: DaemonRequest) => Promise<DaemonResponse>

/**
 * The daemon server interface.
 */
export interface DaemonServer {
  /**
   * Starts the server and begins listening on the Unix socket.
   * Cleans up any stale socket file before starting.
   *
   * @throws {Error} If the server is already running
   */
  start(): void

  /**
   * Stops the server and cleans up the socket file.
   * Idempotent - safe to call multiple times.
   */
  stop(): Promise<void>

  /**
   * Returns whether the server is currently running.
   */
  isRunning(): boolean

  /**
   * The path to the Unix socket.
   */
  readonly socketPath: string
}

// ============================================================================
// Server Implementation
// ============================================================================

/**
 * Creates a new daemon server instance.
 *
 * The server listens on a Unix socket and processes NDJSON requests
 * using the provided handler function.
 *
 * @param handler - Function to process incoming requests
 * @param socketPath - Optional custom socket path (defaults to getSocketPath())
 * @returns A DaemonServer instance
 *
 * @example
 * ```ts
 * const server = createServer(async (request) => {
 *   if (request.type === 'health') {
 *     return successResponse(request.id, { health: { ... } });
 *   }
 *   return errorResponse(request.id, 'unknown request');
 * });
 *
 * server.start();
 * // ... server is now accepting connections ...
 * await server.stop();
 * ```
 */
export function createServer(handler: RequestHandler, socketPath?: string): DaemonServer {
  const path = socketPath ?? getSocketPath()
  let server: ReturnType<typeof Bun.serve> | null = null

  return {
    socketPath: path,

    start(): void {
      if (server !== null) {
        throw new Error('Server is already running')
      }

      // Ensure the socket directory exists with secure permissions
      ensureSocketDir(path)

      // Clean up stale socket file if it exists
      if (existsSync(path)) {
        try {
          unlinkSync(path)
        } catch {
          // Ignore errors - file may have been removed already
        }
      }

      server = Bun.serve({
        unix: path,

        async fetch(req): Promise<Response> {
          const text = await req.text()
          const lines = text.trim().split('\n')

          // Process first line only (single request per connection)
          const line = lines[0]
          if (!line) {
            return new Response(formatResponse(errorResponse('', 'empty request')))
          }

          const parseResult = parseRequest(line)

          if (!parseResult.ok) {
            // Try to extract ID from malformed request for error response
            let id = ''
            try {
              const partial = JSON.parse(line)
              if (
                typeof partial === 'object' &&
                partial !== null &&
                'id' in partial &&
                typeof partial.id === 'string'
              ) {
                id = partial.id
              }
            } catch {
              // Ignore JSON parse errors - use empty id
            }
            return new Response(formatResponse(errorResponse(id, parseResult.error)))
          }

          // Call the handler with the validated request
          const response = await handler(parseResult.value)
          return new Response(formatResponse(response))
        },
      })
    },

    async stop(): Promise<void> {
      if (server !== null) {
        server.stop()
        server = null
      }

      // Clean up socket file
      if (existsSync(path)) {
        try {
          unlinkSync(path)
        } catch {
          // Ignore cleanup errors
        }
      }
    },

    isRunning(): boolean {
      return server !== null
    },
  }
}
