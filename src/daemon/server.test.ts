/**
 * Tests for the daemon Unix socket server.
 *
 * Tests the DaemonServer implementation including:
 * - Starting and stopping the server
 * - Accepting connections and processing NDJSON requests
 * - Error handling for malformed requests
 * - Socket cleanup on start and stop
 *
 * @module daemon/server.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { existsSync, unlinkSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer, type DaemonServer, type RequestHandler } from './server'
import {
  type DaemonRequest,
  type DaemonResponse,
  successResponse,
  errorResponse,
  generateRequestId,
} from './protocol'

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a temporary socket path for testing.
 */
function createTempSocketPath(): { socketPath: string; cleanup: () => void } {
  const tempDir = join(tmpdir(), `pickme-test-${process.pid}-${Date.now()}`)
  mkdirSync(tempDir, { mode: 0o700, recursive: true })
  const socketPath = join(tempDir, 'test.sock')

  return {
    socketPath,
    cleanup: () => {
      try {
        if (existsSync(socketPath)) {
          unlinkSync(socketPath)
        }
        rmSync(tempDir, { recursive: true })
      } catch {
        // Ignore cleanup errors
      }
    },
  }
}

/**
 * Sends a request to the Unix socket and returns the response.
 * Uses fetch with Unix socket transport for simpler request/response.
 */
async function sendRequest(socketPath: string, request: unknown): Promise<DaemonResponse> {
  const response = await fetch(`http://localhost/`, {
    method: 'POST',
    body: JSON.stringify(request) + '\n',
    unix: socketPath,
  } as RequestInit)

  const text = await response.text()
  return JSON.parse(text.trim())
}

/**
 * Creates a mock request handler for testing.
 */
function createMockHandler(responses: Map<string, DaemonResponse> = new Map()): RequestHandler {
  return async (request: DaemonRequest): Promise<DaemonResponse> => {
    const custom = responses.get(request.id)
    if (custom) {
      return custom
    }

    switch (request.type) {
      case 'health':
        return successResponse(request.id, {
          health: {
            uptime: 100,
            rss: 50_000_000,
            generation: 1,
            cacheHitRate: 0.5,
            activeWatchers: 0,
            rootsLoaded: [],
          },
        })
      case 'search':
        return successResponse(request.id, {
          results: [],
          cached: false,
          durationMs: 1.23,
        })
      case 'invalidate':
        return successResponse(request.id)
      case 'stop':
        return successResponse(request.id)
      default:
        return errorResponse(request.id, 'unknown request type')
    }
  }
}

// ============================================================================
// DaemonServer Tests
// ============================================================================

describe('createServer', () => {
  test('creates a server with correct interface', () => {
    const handler = createMockHandler()
    const server = createServer(handler, '/tmp/test-socket.sock')

    expect(server).toBeDefined()
    expect(typeof server.start).toBe('function')
    expect(typeof server.stop).toBe('function')
    expect(typeof server.isRunning).toBe('function')
    expect(server.socketPath).toBe('/tmp/test-socket.sock')
  })

  test('uses provided socket path', () => {
    const handler = createMockHandler()
    const customPath = '/tmp/custom-pickme.sock'
    const server = createServer(handler, customPath)

    expect(server.socketPath).toBe(customPath)
  })
})

describe('DaemonServer.start', () => {
  let server: DaemonServer
  let temp: { socketPath: string; cleanup: () => void }

  beforeEach(() => {
    temp = createTempSocketPath()
  })

  afterEach(async () => {
    if (server?.isRunning()) {
      await server.stop()
    }
    temp.cleanup()
  })

  test('starts and listens on Unix socket', async () => {
    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)

    server.start()

    expect(server.isRunning()).toBe(true)
    expect(existsSync(temp.socketPath)).toBe(true)
  })

  test('cleans up stale socket file on start', async () => {
    // Create a stale socket file
    await Bun.write(temp.socketPath, 'stale')
    expect(existsSync(temp.socketPath)).toBe(true)

    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)

    // Should not throw even with existing file
    server.start()

    expect(server.isRunning()).toBe(true)
  })

  test('throws if already running', () => {
    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)

    server.start()

    expect(() => server.start()).toThrow(/already running/i)
  })
})

describe('DaemonServer.stop', () => {
  let server: DaemonServer
  let temp: { socketPath: string; cleanup: () => void }

  beforeEach(() => {
    temp = createTempSocketPath()
  })

  afterEach(async () => {
    if (server?.isRunning()) {
      await server.stop()
    }
    temp.cleanup()
  })

  test('stops the server', async () => {
    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)

    server.start()
    expect(server.isRunning()).toBe(true)

    await server.stop()
    expect(server.isRunning()).toBe(false)
  })

  test('cleans up socket file on stop', async () => {
    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)

    server.start()
    expect(existsSync(temp.socketPath)).toBe(true)

    await server.stop()
    expect(existsSync(temp.socketPath)).toBe(false)
  })

  test('is idempotent - can be called multiple times', async () => {
    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)

    server.start()
    await server.stop()
    await server.stop() // Second call should not throw

    expect(server.isRunning()).toBe(false)
  })
})

describe('DaemonServer.isRunning', () => {
  let server: DaemonServer
  let temp: { socketPath: string; cleanup: () => void }

  beforeEach(() => {
    temp = createTempSocketPath()
  })

  afterEach(async () => {
    if (server?.isRunning()) {
      await server.stop()
    }
    temp.cleanup()
  })

  test('returns false before start', () => {
    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)

    expect(server.isRunning()).toBe(false)
  })

  test('returns true after start', () => {
    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)

    server.start()

    expect(server.isRunning()).toBe(true)
  })

  test('returns false after stop', async () => {
    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)

    server.start()
    await server.stop()

    expect(server.isRunning()).toBe(false)
  })
})

describe('DaemonServer request handling', () => {
  let server: DaemonServer
  let temp: { socketPath: string; cleanup: () => void }

  beforeEach(() => {
    temp = createTempSocketPath()
  })

  afterEach(async () => {
    if (server?.isRunning()) {
      await server.stop()
    }
    temp.cleanup()
  })

  test('accepts connection and handles health request', async () => {
    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)
    server.start()

    const request = {
      id: generateRequestId(),
      type: 'health',
    }

    const response = await sendRequest(temp.socketPath, request)

    expect(response.id).toBe(request.id)
    expect(response.ok).toBe(true)
    expect(response.health).toBeDefined()
    expect(response.health?.uptime).toBe(100)
  })

  test('accepts connection and handles search request', async () => {
    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)
    server.start()

    const request = {
      id: generateRequestId(),
      type: 'search',
      query: 'test',
    }

    const response = await sendRequest(temp.socketPath, request)

    expect(response.id).toBe(request.id)
    expect(response.ok).toBe(true)
    expect(response.results).toBeDefined()
    expect(response.durationMs).toBeDefined()
  })

  test('responds with formatted NDJSON (newline-terminated)', async () => {
    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)
    server.start()

    // Use fetch with unix socket to get raw response
    const response = await fetch(`http://localhost/`, {
      method: 'POST',
      body: JSON.stringify({ id: 'test', type: 'health' }) + '\n',
      unix: temp.socketPath,
    } as RequestInit)

    const rawResponse = await response.text()

    // Should end with newline (NDJSON format)
    expect(rawResponse.endsWith('\n')).toBe(true)

    // Should be valid JSON
    const parsed = JSON.parse(rawResponse.trim())
    expect(parsed.ok).toBe(true)
  })

  test('handles malformed JSON gracefully', async () => {
    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)
    server.start()

    // Send malformed JSON using fetch
    const response = await fetch(`http://localhost/`, {
      method: 'POST',
      body: 'not valid json\n',
      unix: temp.socketPath,
    } as RequestInit)

    const text = await response.text()
    const parsed = JSON.parse(text.trim()) as DaemonResponse

    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBe('invalid JSON')
  })

  test('handles missing required fields gracefully', async () => {
    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)
    server.start()

    // Missing 'type' field
    const response = await sendRequest(temp.socketPath, { id: 'test-id' })

    expect(response.ok).toBe(false)
    expect(response.error).toBeDefined()
  })

  test('handles empty query validation error', async () => {
    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)
    server.start()

    const request = {
      id: generateRequestId(),
      type: 'search',
      query: '', // Empty query should fail validation
    }

    const response = await sendRequest(temp.socketPath, request)

    expect(response.ok).toBe(false)
    expect(response.error).toBe('empty query')
  })

  test('extracts id from malformed request for error response', async () => {
    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)
    server.start()

    // Valid JSON but missing required 'type' field
    const response = await sendRequest(temp.socketPath, {
      id: 'my-request-id',
    })

    // Error response should include the extracted id
    expect(response.id).toBe('my-request-id')
    expect(response.ok).toBe(false)
  })

  test('calls handler with parsed request', async () => {
    let receivedRequest: DaemonRequest | null = null

    const handler: RequestHandler = async (request: DaemonRequest): Promise<DaemonResponse> => {
      receivedRequest = request
      return successResponse(request.id)
    }

    server = createServer(handler, temp.socketPath)
    server.start()

    const request = {
      id: 'test-123',
      type: 'invalidate',
      root: '/test/root',
    }

    await sendRequest(temp.socketPath, request)

    expect(receivedRequest).not.toBeNull()
    expect(receivedRequest?.id).toBe('test-123')
    expect(receivedRequest?.type).toBe('invalidate')
    expect((receivedRequest as { root?: string })?.root).toBe('/test/root')
  })
})

describe('DaemonServer concurrent connections', () => {
  let server: DaemonServer
  let temp: { socketPath: string; cleanup: () => void }

  beforeEach(() => {
    temp = createTempSocketPath()
  })

  afterEach(async () => {
    if (server?.isRunning()) {
      await server.stop()
    }
    temp.cleanup()
  })

  test('handles multiple sequential requests', async () => {
    const handler = createMockHandler()
    server = createServer(handler, temp.socketPath)
    server.start()

    // Send multiple requests sequentially
    for (let i = 0; i < 3; i++) {
      const request = {
        id: `request-${i}`,
        type: 'health',
      }

      const response = await sendRequest(temp.socketPath, request)
      expect(response.id).toBe(`request-${i}`)
      expect(response.ok).toBe(true)
    }
  })
})
