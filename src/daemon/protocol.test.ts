/**
 * Tests for the daemon protocol types and helpers.
 *
 * Tests Zod schema validation, request parsing, response formatting,
 * and helper functions for daemon communication.
 *
 * @module daemon/protocol.test
 */

import { describe, test, expect } from 'bun:test'
import {
  parseRequest,
  formatResponse,
  generateRequestId,
  errorResponse,
  successResponse,
  ok,
  err,
  DaemonRequestSchema,
  SearchRequestSchema,
  HealthRequestSchema,
  InvalidateRequestSchema,
  StopRequestSchema,
  type DaemonRequest,
  type DaemonResponse,
  type SearchRequest,
  type HealthRequest,
  type InvalidateRequest,
  type StopRequest,
  type DaemonSearchResult,
  type HealthInfo,
  type Result,
} from './protocol'

// ============================================================================
// Result Type Tests
// ============================================================================

describe('Result type helpers', () => {
  test('ok() creates a successful result', () => {
    const result = ok(42)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value).toBe(42)
    }
  })

  test('err() creates a failed result', () => {
    const result = err('something went wrong')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('something went wrong')
    }
  })

  test('Result type discriminates correctly', () => {
    const success: Result<number, string> = ok(123)
    const failure: Result<number, string> = err('error')

    // Type narrowing should work
    if (success.ok) {
      const _value: number = success.value
      expect(_value).toBe(123)
    }

    if (!failure.ok) {
      const _error: string = failure.error
      expect(_error).toBe('error')
    }
  })
})

// ============================================================================
// generateRequestId Tests
// ============================================================================

describe('generateRequestId', () => {
  test('returns a string', () => {
    const id = generateRequestId()
    expect(typeof id).toBe('string')
  })

  test('returns a valid UUID format', () => {
    const id = generateRequestId()
    // UUID v4 format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    expect(uuidRegex.test(id)).toBe(true)
  })

  test('returns unique IDs on consecutive calls', () => {
    const ids = new Set<string>()
    for (let i = 0; i < 100; i++) {
      ids.add(generateRequestId())
    }
    // All 100 IDs should be unique
    expect(ids.size).toBe(100)
  })
})

// ============================================================================
// parseRequest Tests - Valid Requests
// ============================================================================

describe('parseRequest - valid requests', () => {
  test('accepts valid search request', () => {
    const line = JSON.stringify({
      id: 'test-id',
      type: 'search',
      query: 'button',
    })

    const result = parseRequest(line)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.type).toBe('search')
      expect(result.value.id).toBe('test-id')
      if (result.value.type === 'search') {
        expect(result.value.query).toBe('button')
      }
    }
  })

  test('accepts search request with optional fields', () => {
    const line = JSON.stringify({
      id: 'test-id',
      type: 'search',
      query: 'button',
      cwd: '/home/user/project',
      limit: 25,
    })

    const result = parseRequest(line)

    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'search') {
      expect(result.value.cwd).toBe('/home/user/project')
      expect(result.value.limit).toBe(25)
    }
  })

  test('applies default limit of 50 for search requests', () => {
    const line = JSON.stringify({
      id: 'test-id',
      type: 'search',
      query: 'button',
    })

    const result = parseRequest(line)

    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'search') {
      expect(result.value.limit).toBe(50)
    }
  })

  test('accepts valid health request', () => {
    const line = JSON.stringify({
      id: 'health-id',
      type: 'health',
    })

    const result = parseRequest(line)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.type).toBe('health')
      expect(result.value.id).toBe('health-id')
    }
  })

  test('accepts valid invalidate request without root', () => {
    const line = JSON.stringify({
      id: 'inv-id',
      type: 'invalidate',
    })

    const result = parseRequest(line)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.type).toBe('invalidate')
      expect(result.value.id).toBe('inv-id')
    }
  })

  test('accepts valid invalidate request with root', () => {
    const line = JSON.stringify({
      id: 'inv-id',
      type: 'invalidate',
      root: '/home/user/project',
    })

    const result = parseRequest(line)

    expect(result.ok).toBe(true)
    if (result.ok && result.value.type === 'invalidate') {
      expect(result.value.root).toBe('/home/user/project')
    }
  })

  test('accepts valid stop request', () => {
    const line = JSON.stringify({
      id: 'stop-id',
      type: 'stop',
    })

    const result = parseRequest(line)

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.type).toBe('stop')
      expect(result.value.id).toBe('stop-id')
    }
  })
})

// ============================================================================
// parseRequest Tests - Invalid Requests
// ============================================================================

describe('parseRequest - invalid requests', () => {
  test('rejects invalid JSON', () => {
    const result = parseRequest('not valid json {{{')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('invalid JSON')
    }
  })

  test('rejects empty string', () => {
    const result = parseRequest('')

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('invalid JSON')
    }
  })

  test('rejects missing id field', () => {
    const line = JSON.stringify({
      type: 'health',
    })

    const result = parseRequest(line)

    expect(result.ok).toBe(false)
  })

  test('rejects empty id field', () => {
    const line = JSON.stringify({
      id: '',
      type: 'health',
    })

    const result = parseRequest(line)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('id is required')
    }
  })

  test('rejects missing type field', () => {
    const line = JSON.stringify({
      id: 'test-id',
    })

    const result = parseRequest(line)

    expect(result.ok).toBe(false)
  })

  test('rejects unknown type', () => {
    const line = JSON.stringify({
      id: 'test-id',
      type: 'unknown',
    })

    const result = parseRequest(line)

    expect(result.ok).toBe(false)
  })

  test('rejects search request with missing query', () => {
    const line = JSON.stringify({
      id: 'test-id',
      type: 'search',
    })

    const result = parseRequest(line)

    expect(result.ok).toBe(false)
  })

  test('rejects search request with empty query', () => {
    const line = JSON.stringify({
      id: 'test-id',
      type: 'search',
      query: '',
    })

    const result = parseRequest(line)

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toBe('empty query')
    }
  })

  test('rejects search request with non-positive limit', () => {
    const line = JSON.stringify({
      id: 'test-id',
      type: 'search',
      query: 'button',
      limit: 0,
    })

    const result = parseRequest(line)

    expect(result.ok).toBe(false)
  })

  test('rejects search request with negative limit', () => {
    const line = JSON.stringify({
      id: 'test-id',
      type: 'search',
      query: 'button',
      limit: -5,
    })

    const result = parseRequest(line)

    expect(result.ok).toBe(false)
  })

  test('rejects search request with non-integer limit', () => {
    const line = JSON.stringify({
      id: 'test-id',
      type: 'search',
      query: 'button',
      limit: 10.5,
    })

    const result = parseRequest(line)

    expect(result.ok).toBe(false)
  })

  test('rejects non-object input', () => {
    const result = parseRequest('"just a string"')

    expect(result.ok).toBe(false)
  })

  test('rejects array input', () => {
    const result = parseRequest('[{"id":"test","type":"health"}]')

    expect(result.ok).toBe(false)
  })

  test('rejects null input', () => {
    const result = parseRequest('null')

    expect(result.ok).toBe(false)
  })
})

// ============================================================================
// formatResponse Tests
// ============================================================================

describe('formatResponse', () => {
  test('produces valid JSON', () => {
    const response: DaemonResponse = {
      id: 'test-id',
      ok: true,
    }

    const formatted = formatResponse(response)
    const parsed = JSON.parse(formatted.trim())

    expect(parsed.id).toBe('test-id')
    expect(parsed.ok).toBe(true)
  })

  test('ends with newline (NDJSON format)', () => {
    const response: DaemonResponse = {
      id: 'test-id',
      ok: true,
    }

    const formatted = formatResponse(response)

    expect(formatted.endsWith('\n')).toBe(true)
  })

  test('has exactly one trailing newline', () => {
    const response: DaemonResponse = {
      id: 'test-id',
      ok: true,
    }

    const formatted = formatResponse(response)

    expect(formatted.endsWith('\n')).toBe(true)
    expect(formatted.endsWith('\n\n')).toBe(false)
  })

  test('includes all response fields', () => {
    const response: DaemonResponse = {
      id: 'test-id',
      ok: true,
      results: [{ path: '/test/file.ts', score: 0.95, root: '/test' }],
      cached: false,
      durationMs: 12.5,
    }

    const formatted = formatResponse(response)
    const parsed = JSON.parse(formatted.trim())

    expect(parsed.id).toBe('test-id')
    expect(parsed.ok).toBe(true)
    expect(parsed.results).toHaveLength(1)
    expect(parsed.results[0].path).toBe('/test/file.ts')
    expect(parsed.cached).toBe(false)
    expect(parsed.durationMs).toBe(12.5)
  })

  test('formats error response correctly', () => {
    const response: DaemonResponse = {
      id: 'test-id',
      ok: false,
      error: 'something went wrong',
    }

    const formatted = formatResponse(response)
    const parsed = JSON.parse(formatted.trim())

    expect(parsed.id).toBe('test-id')
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toBe('something went wrong')
  })

  test('formats health response correctly', () => {
    const health: HealthInfo = {
      uptime: 3600,
      rss: 50_000_000,
      generation: 5,
      cacheHitRate: 0.85,
      activeWatchers: 3,
      rootsLoaded: ['/home/user/project1', '/home/user/project2'],
    }

    const response: DaemonResponse = {
      id: 'health-id',
      ok: true,
      health,
    }

    const formatted = formatResponse(response)
    const parsed = JSON.parse(formatted.trim())

    expect(parsed.health.uptime).toBe(3600)
    expect(parsed.health.rss).toBe(50_000_000)
    expect(parsed.health.generation).toBe(5)
    expect(parsed.health.cacheHitRate).toBe(0.85)
    expect(parsed.health.activeWatchers).toBe(3)
    expect(parsed.health.rootsLoaded).toEqual(['/home/user/project1', '/home/user/project2'])
  })
})

// ============================================================================
// errorResponse Tests
// ============================================================================

describe('errorResponse', () => {
  test('creates response with ok: false', () => {
    const response = errorResponse('test-id', 'test error')

    expect(response.ok).toBe(false)
  })

  test('includes the request id', () => {
    const response = errorResponse('my-request-id', 'error')

    expect(response.id).toBe('my-request-id')
  })

  test('includes the error message', () => {
    const response = errorResponse('test-id', 'something went wrong')

    expect(response.error).toBe('something went wrong')
  })

  test('produces correct shape', () => {
    const response = errorResponse('id-123', 'oops')

    expect(response).toEqual({
      id: 'id-123',
      ok: false,
      error: 'oops',
    })
  })

  test('handles empty error message', () => {
    const response = errorResponse('test-id', '')

    expect(response.error).toBe('')
  })

  test('handles empty id', () => {
    const response = errorResponse('', 'error')

    expect(response.id).toBe('')
  })
})

// ============================================================================
// successResponse Tests
// ============================================================================

describe('successResponse', () => {
  test('creates response with ok: true', () => {
    const response = successResponse('test-id')

    expect(response.ok).toBe(true)
  })

  test('includes the request id', () => {
    const response = successResponse('my-request-id')

    expect(response.id).toBe('my-request-id')
  })

  test('works without additional data', () => {
    const response = successResponse('test-id')

    expect(response).toEqual({
      id: 'test-id',
      ok: true,
    })
  })

  test('includes search results when provided', () => {
    const results: DaemonSearchResult[] = [
      { path: '/test/Button.tsx', score: 0.95, root: '/test' },
      { path: '/test/Modal.tsx', score: 0.8, root: '/test' },
    ]

    const response = successResponse('test-id', { results })

    expect(response.results).toEqual(results)
    expect(response.ok).toBe(true)
  })

  test('includes cached flag when provided', () => {
    const response = successResponse('test-id', { cached: true })

    expect(response.cached).toBe(true)
  })

  test('includes durationMs when provided', () => {
    const response = successResponse('test-id', { durationMs: 42.5 })

    expect(response.durationMs).toBe(42.5)
  })

  test('includes health info when provided', () => {
    const health: HealthInfo = {
      uptime: 1000,
      rss: 10_000_000,
      generation: 1,
      cacheHitRate: 0.5,
      activeWatchers: 0,
      rootsLoaded: [],
    }

    const response = successResponse('test-id', { health })

    expect(response.health).toEqual(health)
  })

  test('combines multiple optional fields', () => {
    const results: DaemonSearchResult[] = [{ path: '/test/file.ts', score: 1.0, root: '/test' }]

    const response = successResponse('test-id', {
      results,
      cached: false,
      durationMs: 15.3,
    })

    expect(response.id).toBe('test-id')
    expect(response.ok).toBe(true)
    expect(response.results).toEqual(results)
    expect(response.cached).toBe(false)
    expect(response.durationMs).toBe(15.3)
  })
})

// ============================================================================
// Zod Schema Tests
// ============================================================================

describe('Zod schemas', () => {
  describe('SearchRequestSchema', () => {
    test('parses valid request', () => {
      const result = SearchRequestSchema.safeParse({
        id: 'test',
        type: 'search',
        query: 'button',
      })

      expect(result.success).toBe(true)
    })

    test('applies default limit', () => {
      const result = SearchRequestSchema.safeParse({
        id: 'test',
        type: 'search',
        query: 'button',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.limit).toBe(50)
      }
    })

    test('rejects wrong type literal', () => {
      const result = SearchRequestSchema.safeParse({
        id: 'test',
        type: 'health',
        query: 'button',
      })

      expect(result.success).toBe(false)
    })
  })

  describe('HealthRequestSchema', () => {
    test('parses valid request', () => {
      const result = HealthRequestSchema.safeParse({
        id: 'test',
        type: 'health',
      })

      expect(result.success).toBe(true)
    })

    test('rejects extra required fields', () => {
      const result = HealthRequestSchema.safeParse({
        id: 'test',
        type: 'health',
        query: 'should not be here',
      })

      // Extra fields are stripped by default in Zod
      expect(result.success).toBe(true)
    })
  })

  describe('InvalidateRequestSchema', () => {
    test('parses valid request without root', () => {
      const result = InvalidateRequestSchema.safeParse({
        id: 'test',
        type: 'invalidate',
      })

      expect(result.success).toBe(true)
    })

    test('parses valid request with root', () => {
      const result = InvalidateRequestSchema.safeParse({
        id: 'test',
        type: 'invalidate',
        root: '/home/user',
      })

      expect(result.success).toBe(true)
      if (result.success) {
        expect(result.data.root).toBe('/home/user')
      }
    })
  })

  describe('StopRequestSchema', () => {
    test('parses valid request', () => {
      const result = StopRequestSchema.safeParse({
        id: 'test',
        type: 'stop',
      })

      expect(result.success).toBe(true)
    })
  })

  describe('DaemonRequestSchema', () => {
    test('discriminates on type field', () => {
      const search = DaemonRequestSchema.safeParse({
        id: '1',
        type: 'search',
        query: 'test',
      })
      const health = DaemonRequestSchema.safeParse({
        id: '2',
        type: 'health',
      })
      const invalidate = DaemonRequestSchema.safeParse({
        id: '3',
        type: 'invalidate',
      })
      const stop = DaemonRequestSchema.safeParse({
        id: '4',
        type: 'stop',
      })

      expect(search.success).toBe(true)
      expect(health.success).toBe(true)
      expect(invalidate.success).toBe(true)
      expect(stop.success).toBe(true)
    })

    test('rejects unknown type', () => {
      const result = DaemonRequestSchema.safeParse({
        id: 'test',
        type: 'foobar',
      })

      expect(result.success).toBe(false)
    })
  })
})

// ============================================================================
// Type Export Tests
// ============================================================================

describe('type exports', () => {
  test('exports DaemonRequest type', () => {
    const _request: DaemonRequest = {
      id: 'test',
      type: 'health',
    }
    expect(_request.type).toBe('health')
  })

  test('exports SearchRequest type', () => {
    const _request: SearchRequest = {
      id: 'test',
      type: 'search',
      query: 'button',
    }
    expect(_request.type).toBe('search')
  })

  test('exports HealthRequest type', () => {
    const _request: HealthRequest = {
      id: 'test',
      type: 'health',
    }
    expect(_request.type).toBe('health')
  })

  test('exports InvalidateRequest type', () => {
    const _request: InvalidateRequest = {
      id: 'test',
      type: 'invalidate',
    }
    expect(_request.type).toBe('invalidate')
  })

  test('exports StopRequest type', () => {
    const _request: StopRequest = {
      id: 'test',
      type: 'stop',
    }
    expect(_request.type).toBe('stop')
  })

  test('exports DaemonResponse type', () => {
    const _response: DaemonResponse = {
      id: 'test',
      ok: true,
    }
    expect(_response.ok).toBe(true)
  })

  test('exports DaemonSearchResult type', () => {
    const _result: DaemonSearchResult = {
      path: '/test/file.ts',
      score: 0.95,
      root: '/test',
    }
    expect(_result.path).toBe('/test/file.ts')
  })

  test('exports HealthInfo type', () => {
    const _health: HealthInfo = {
      uptime: 100,
      rss: 1000,
      generation: 1,
      cacheHitRate: 0.5,
      activeWatchers: 0,
      rootsLoaded: [],
    }
    expect(_health.uptime).toBe(100)
  })

  test('exports Result type', () => {
    const success: Result<number, string> = ok(42)
    const failure: Result<number, string> = err('error')

    expect(success.ok).toBe(true)
    expect(failure.ok).toBe(false)
  })
})
