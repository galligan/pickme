/**
 * Tests for daemon client communication.
 *
 * Tests client functions for communicating with the pickme daemon,
 * including health checks, request/response handling, and error cases.
 *
 * @module daemon/client.test
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createServer, type Server, type Socket } from 'node:net'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isDaemonRunning, sendRequest, queryDaemon } from './client'

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a temporary directory for socket files.
 */
function createTempDir(): { path: string; cleanup: () => void } {
  const tempDir = mkdtempSync(join(tmpdir(), 'daemon-client-test-'))
  return {
    path: tempDir,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true })
      } catch {
        // Ignore cleanup errors
      }
    },
  }
}

/**
 * Creates a mock daemon server that responds to requests.
 * If handler returns null, the connection is kept open (useful for testing timeouts).
 */
function createMockServer(
  socketPath: string,
  handler: (data: string) => string | null
): { server: Server; close: () => Promise<void> } {
  const sockets: Socket[] = []
  const server = createServer(socket => {
    sockets.push(socket)
    let buffer = ''
    socket.on('data', chunk => {
      buffer += chunk.toString()
      if (buffer.includes('\n')) {
        const response = handler(buffer.trim())
        if (response !== null) {
          socket.write(response)
          socket.end()
        }
        // If response is null, keep connection open (for timeout tests)
      }
    })
  })

  server.listen(socketPath)

  return {
    server,
    close: () =>
      new Promise(resolve => {
        for (const socket of sockets) {
          socket.destroy()
        }
        server.close(() => resolve())
      }),
  }
}

// ============================================================================
// isDaemonRunning Tests
// ============================================================================

describe('isDaemonRunning', () => {
  test('returns false for nonexistent socket', async () => {
    const result = await isDaemonRunning('/nonexistent/path/pickme.sock')
    expect(result).toBe(false)
  })

  test('returns false when socket file does not exist', async () => {
    const tempDir = createTempDir()
    try {
      const socketPath = join(tempDir.path, 'pickme.sock')
      // Socket file doesn't exist, should return false early
      const result = await isDaemonRunning(socketPath)
      expect(result).toBe(false)
    } finally {
      tempDir.cleanup()
    }
  })

  test('returns true when daemon responds with ok', async () => {
    const tempDir = createTempDir()
    const socketPath = join(tempDir.path, 'pickme.sock')

    const mock = createMockServer(socketPath, () =>
      JSON.stringify({ id: 'test', ok: true, health: { uptime: 100 } })
    )

    try {
      const result = await isDaemonRunning(socketPath)
      expect(result).toBe(true)
    } finally {
      await mock.close()
      tempDir.cleanup()
    }
  })

  test('returns false when daemon responds with error', async () => {
    const tempDir = createTempDir()
    const socketPath = join(tempDir.path, 'pickme.sock')

    const mock = createMockServer(socketPath, () =>
      JSON.stringify({ id: 'test', ok: false, error: 'unhealthy' })
    )

    try {
      const result = await isDaemonRunning(socketPath)
      expect(result).toBe(false)
    } finally {
      await mock.close()
      tempDir.cleanup()
    }
  })
})

// ============================================================================
// sendRequest Tests
// ============================================================================

describe('sendRequest', () => {
  test('times out after specified duration', async () => {
    const tempDir = createTempDir()
    const socketPath = join(tempDir.path, 'pickme.sock')

    // Create server that never responds
    const mock = createMockServer(socketPath, () => null)

    try {
      await expect(sendRequest(socketPath, { type: 'health' }, 50)).rejects.toThrow(
        'Daemon request timeout'
      )
    } finally {
      await mock.close()
      tempDir.cleanup()
    }
  })

  test('rejects on connection error', async () => {
    await expect(sendRequest('/nonexistent/socket.sock', { type: 'health' })).rejects.toThrow()
  })

  test('rejects on invalid JSON response', async () => {
    const tempDir = createTempDir()
    const socketPath = join(tempDir.path, 'pickme.sock')

    const mock = createMockServer(socketPath, () => 'not valid json')

    try {
      await expect(sendRequest(socketPath, { type: 'health' })).rejects.toThrow(
        'Invalid daemon response'
      )
    } finally {
      await mock.close()
      tempDir.cleanup()
    }
  })

  test('parses valid JSON response', async () => {
    const tempDir = createTempDir()
    const socketPath = join(tempDir.path, 'pickme.sock')

    const mock = createMockServer(socketPath, () =>
      JSON.stringify({ id: 'test', ok: true, data: 'hello' })
    )

    try {
      const response = await sendRequest(socketPath, { type: 'health' })
      expect(response.ok).toBe(true)
      expect(response.data).toBe('hello')
    } finally {
      await mock.close()
      tempDir.cleanup()
    }
  })

  test('adds id to request if not present', async () => {
    const tempDir = createTempDir()
    const socketPath = join(tempDir.path, 'pickme.sock')

    let receivedRequest: Record<string, unknown> | null = null
    const mock = createMockServer(socketPath, data => {
      receivedRequest = JSON.parse(data) as Record<string, unknown>
      return JSON.stringify({ id: receivedRequest.id, ok: true })
    })

    try {
      await sendRequest(socketPath, { type: 'health' })
      expect(receivedRequest).not.toBeNull()
      // TypeScript doesn't know callback ran, use non-null assertion
      const req = receivedRequest!
      expect(req.id).toBeDefined()
      expect(typeof req.id).toBe('string')
    } finally {
      await mock.close()
      tempDir.cleanup()
    }
  })
})

// ============================================================================
// queryDaemon Tests
// ============================================================================

describe('queryDaemon', () => {
  test('parses success response correctly', async () => {
    const tempDir = createTempDir()
    const socketPath = join(tempDir.path, 'pickme.sock')

    const mockResults = [
      { path: '/foo/bar.ts', score: 10, root: '/foo' },
      { path: '/foo/baz.ts', score: 5, root: '/foo' },
    ]

    const mock = createMockServer(socketPath, data => {
      const request = JSON.parse(data) as Record<string, unknown>
      return JSON.stringify({
        id: request.id,
        ok: true,
        results: mockResults,
        cached: true,
        durationMs: 5,
      })
    })

    try {
      const response = await queryDaemon(socketPath, {
        query: 'test',
        cwd: '/foo',
        limit: 50,
      })

      expect(response.results).toEqual(mockResults)
      expect(response.cached).toBe(true)
      expect(response.durationMs).toBe(5)
    } finally {
      await mock.close()
      tempDir.cleanup()
    }
  })

  test('throws on error response', async () => {
    const tempDir = createTempDir()
    const socketPath = join(tempDir.path, 'pickme.sock')

    const mock = createMockServer(socketPath, data => {
      const request = JSON.parse(data) as Record<string, unknown>
      return JSON.stringify({
        id: request.id,
        ok: false,
        error: 'Query failed: invalid query',
      })
    })

    try {
      await expect(
        queryDaemon(socketPath, {
          query: 'test',
          cwd: '/foo',
        })
      ).rejects.toThrow('Query failed: invalid query')
    } finally {
      await mock.close()
      tempDir.cleanup()
    }
  })

  test('handles empty results array', async () => {
    const tempDir = createTempDir()
    const socketPath = join(tempDir.path, 'pickme.sock')

    const mock = createMockServer(socketPath, data => {
      const request = JSON.parse(data) as Record<string, unknown>
      return JSON.stringify({
        id: request.id,
        ok: true,
        results: [],
        cached: false,
        durationMs: 1,
      })
    })

    try {
      const response = await queryDaemon(socketPath, {
        query: 'nonexistent',
        cwd: '/foo',
      })

      expect(response.results).toEqual([])
      expect(response.cached).toBe(false)
    } finally {
      await mock.close()
      tempDir.cleanup()
    }
  })

  test('sends correct request format', async () => {
    const tempDir = createTempDir()
    const socketPath = join(tempDir.path, 'pickme.sock')

    let receivedRequest: Record<string, unknown> | null = null
    const mock = createMockServer(socketPath, data => {
      receivedRequest = JSON.parse(data) as Record<string, unknown>
      return JSON.stringify({
        id: receivedRequest.id,
        ok: true,
        results: [],
        cached: false,
        durationMs: 1,
      })
    })

    try {
      await queryDaemon(socketPath, {
        query: 'test query',
        cwd: '/test/cwd',
        limit: 25,
      })

      expect(receivedRequest).not.toBeNull()
      // TypeScript doesn't know callback ran, use non-null assertion
      const req = receivedRequest!
      expect(req.type).toBe('search')
      expect(req.query).toBe('test query')
      expect(req.cwd).toBe('/test/cwd')
      expect(req.limit).toBe(25)
    } finally {
      await mock.close()
      tempDir.cleanup()
    }
  })

  test('defaults limit to 50', async () => {
    const tempDir = createTempDir()
    const socketPath = join(tempDir.path, 'pickme.sock')

    let receivedRequest: Record<string, unknown> | null = null
    const mock = createMockServer(socketPath, data => {
      receivedRequest = JSON.parse(data) as Record<string, unknown>
      return JSON.stringify({
        id: receivedRequest.id,
        ok: true,
        results: [],
        cached: false,
        durationMs: 1,
      })
    })

    try {
      await queryDaemon(socketPath, {
        query: 'test',
        cwd: '/foo',
        // No limit specified
      })

      // TypeScript doesn't know callback ran, use non-null assertion
      expect(receivedRequest!.limit).toBe(50)
    } finally {
      await mock.close()
      tempDir.cleanup()
    }
  })
})
