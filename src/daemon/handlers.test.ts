/**
 * Tests for daemon request handlers.
 *
 * @module daemon/handlers.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { createFilePicker, type FilePicker } from '../index'
import { handleRequest, createInitialState, type DaemonState } from './handlers'
import type {
  SearchRequest,
  HealthRequest,
  InvalidateRequest,
  StopRequest,
  DaemonResponse,
} from './protocol'

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a temporary directory structure for testing.
 */
function createTempProject(): {
  root: string
  cleanup: () => void
} {
  const tempDir = mkdtempSync(join(tmpdir(), 'daemon-handlers-test-'))

  // Create a project structure
  mkdirSync(join(tempDir, 'src', 'components'), { recursive: true })
  mkdirSync(join(tempDir, 'src', 'utils'), { recursive: true })

  // Create test files
  writeFileSync(join(tempDir, 'src', 'components', 'Button.tsx'), 'export const Button = () => {}')
  writeFileSync(join(tempDir, 'src', 'components', 'Modal.tsx'), 'export const Modal = () => {}')
  writeFileSync(join(tempDir, 'src', 'utils', 'helpers.ts'), 'export const helper = () => {}')
  writeFileSync(join(tempDir, 'src', 'index.ts'), 'export * from "./components"')
  writeFileSync(join(tempDir, 'README.md'), '# Test Project')

  return {
    root: tempDir,
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
 * Creates a temp database path for testing.
 */
function createTempDbPath(): { dbPath: string; cleanup: () => void } {
  const tempDir = mkdtempSync(join(tmpdir(), 'daemon-handlers-db-'))
  const dbPath = join(tempDir, 'test-index.db')

  return {
    dbPath,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true })
      } catch {
        // Ignore cleanup errors
      }
    },
  }
}

// ============================================================================
// createInitialState Tests
// ============================================================================

describe('createInitialState', () => {
  test('returns state with current timestamp', () => {
    const before = Date.now()
    const state = createInitialState()
    const after = Date.now()

    expect(state.startTime).toBeGreaterThanOrEqual(before)
    expect(state.startTime).toBeLessThanOrEqual(after)
  })

  test('returns state with zero generation', () => {
    const state = createInitialState()
    expect(state.generation).toBe(0)
  })

  test('returns state with zero cache counts', () => {
    const state = createInitialState()
    expect(state.cacheHits).toBe(0)
    expect(state.cacheTotal).toBe(0)
  })
})

// ============================================================================
// handleRequest - Search Tests
// ============================================================================

describe('handleRequest - search', () => {
  let picker: FilePicker
  let state: DaemonState
  let project: { root: string; cleanup: () => void }
  let dbCleanup: () => void
  let dbPath: string

  beforeEach(async () => {
    const temp = createTempDbPath()
    dbPath = temp.dbPath
    dbCleanup = temp.cleanup

    project = createTempProject()
    picker = await createFilePicker({ dbPath })
    state = createInitialState()

    // Index the test project
    await picker.ensureIndexed([project.root])
  })

  afterEach(async () => {
    await picker.close()
    project.cleanup()
    dbCleanup()
  })

  test('returns results array with path, score, root', async () => {
    const request: SearchRequest = {
      id: 'test-1',
      type: 'search',
      query: 'Button',
      cwd: project.root,
    }

    const response = await handleRequest(request, state, picker)

    expect(response.ok).toBe(true)
    expect(response.id).toBe('test-1')
    expect(response.results).toBeDefined()
    expect(response.results!.length).toBeGreaterThanOrEqual(1)

    const result = response.results![0]!
    expect(result.path).toBeDefined()
    expect(typeof result.path).toBe('string')
    expect(result.score).toBeDefined()
    expect(typeof result.score).toBe('number')
    expect(result.root).toBeDefined()
    expect(typeof result.root).toBe('string')
  })

  test('includes durationMs in response', async () => {
    const request: SearchRequest = {
      id: 'test-2',
      type: 'search',
      query: 'Button',
      cwd: project.root,
    }

    const response = await handleRequest(request, state, picker)

    expect(response.ok).toBe(true)
    expect(response.durationMs).toBeDefined()
    expect(typeof response.durationMs).toBe('number')
    expect(response.durationMs).toBeGreaterThanOrEqual(0)
  })

  test('respects limit parameter', async () => {
    const request: SearchRequest = {
      id: 'test-3',
      type: 'search',
      query: 'ts',
      cwd: project.root,
      limit: 2,
    }

    const response = await handleRequest(request, state, picker)

    expect(response.ok).toBe(true)
    expect(response.results).toBeDefined()
    expect(response.results!.length).toBeLessThanOrEqual(2)
  })

  test('returns empty results for no matches', async () => {
    const request: SearchRequest = {
      id: 'test-4',
      type: 'search',
      query: 'nonexistentfilethatwillnotmatch',
      cwd: project.root,
    }

    const response = await handleRequest(request, state, picker)

    expect(response.ok).toBe(true)
    expect(response.results).toBeDefined()
    expect(response.results!.length).toBe(0)
  })

  test('sets cached to false in foundation phase', async () => {
    const request: SearchRequest = {
      id: 'test-5',
      type: 'search',
      query: 'Button',
      cwd: project.root,
    }

    const response = await handleRequest(request, state, picker)

    expect(response.ok).toBe(true)
    expect(response.cached).toBe(false)
  })

  test('finds files by partial name', async () => {
    const request: SearchRequest = {
      id: 'test-6',
      type: 'search',
      query: 'Butt',
      cwd: project.root,
    }

    const response = await handleRequest(request, state, picker)

    expect(response.ok).toBe(true)
    expect(response.results!.some(r => r.path.includes('Button'))).toBe(true)
  })

  test('root field matches cwd when path is under cwd', async () => {
    const request: SearchRequest = {
      id: 'test-7',
      type: 'search',
      query: 'Button',
      cwd: project.root,
    }

    const response = await handleRequest(request, state, picker)

    expect(response.ok).toBe(true)
    expect(response.results!.length).toBeGreaterThanOrEqual(1)
    // All results should have root set to cwd or a parent directory
    for (const result of response.results!) {
      expect(result.path.startsWith(result.root)).toBe(true)
    }
  })
})

// ============================================================================
// handleRequest - Health Tests
// ============================================================================

describe('handleRequest - health', () => {
  let picker: FilePicker
  let state: DaemonState
  let dbCleanup: () => void
  let dbPath: string

  beforeEach(async () => {
    const temp = createTempDbPath()
    dbPath = temp.dbPath
    dbCleanup = temp.cleanup

    picker = await createFilePicker({ dbPath })
    state = createInitialState()
  })

  afterEach(async () => {
    await picker.close()
    dbCleanup()
  })

  test('returns valid uptime', async () => {
    const request: HealthRequest = {
      id: 'health-1',
      type: 'health',
    }

    // Wait a bit to ensure uptime > 0
    await new Promise(resolve => setTimeout(resolve, 10))

    const response = await handleRequest(request, state, picker)

    expect(response.ok).toBe(true)
    expect(response.health).toBeDefined()
    expect(response.health!.uptime).toBeDefined()
    expect(typeof response.health!.uptime).toBe('number')
    expect(response.health!.uptime).toBeGreaterThanOrEqual(0)
  })

  test('returns valid rss', async () => {
    const request: HealthRequest = {
      id: 'health-2',
      type: 'health',
    }

    const response = await handleRequest(request, state, picker)

    expect(response.ok).toBe(true)
    expect(response.health!.rss).toBeDefined()
    expect(typeof response.health!.rss).toBe('number')
    expect(response.health!.rss).toBeGreaterThan(0)
  })

  test('returns correct generation', async () => {
    const request: HealthRequest = {
      id: 'health-3',
      type: 'health',
    }

    // Initial state has generation 0
    let response = await handleRequest(request, state, picker)
    expect(response.health!.generation).toBe(0)

    // Manually increment generation
    state.generation = 5
    response = await handleRequest(request, state, picker)
    expect(response.health!.generation).toBe(5)
  })

  test('returns cache hit rate based on state', async () => {
    const request: HealthRequest = {
      id: 'health-4',
      type: 'health',
    }

    // With no cache lookups, rate should be 0
    let response = await handleRequest(request, state, picker)
    expect(response.health!.cacheHitRate).toBe(0)

    // Simulate cache stats
    state.cacheTotal = 10
    state.cacheHits = 7
    response = await handleRequest(request, state, picker)
    expect(response.health!.cacheHitRate).toBe(0.7)
  })

  test('returns activeWatchers as 0 in foundation phase', async () => {
    const request: HealthRequest = {
      id: 'health-5',
      type: 'health',
    }

    const response = await handleRequest(request, state, picker)

    expect(response.health!.activeWatchers).toBe(0)
  })

  test('returns empty rootsLoaded in foundation phase', async () => {
    const request: HealthRequest = {
      id: 'health-6',
      type: 'health',
    }

    const response = await handleRequest(request, state, picker)

    expect(response.health!.rootsLoaded).toEqual([])
  })
})

// ============================================================================
// handleRequest - Invalidate Tests
// ============================================================================

describe('handleRequest - invalidate', () => {
  let picker: FilePicker
  let state: DaemonState
  let dbCleanup: () => void
  let dbPath: string

  beforeEach(async () => {
    const temp = createTempDbPath()
    dbPath = temp.dbPath
    dbCleanup = temp.cleanup

    picker = await createFilePicker({ dbPath })
    state = createInitialState()
  })

  afterEach(async () => {
    await picker.close()
    dbCleanup()
  })

  test('increments generation', async () => {
    const request: InvalidateRequest = {
      id: 'invalidate-1',
      type: 'invalidate',
    }

    expect(state.generation).toBe(0)

    const response = await handleRequest(request, state, picker)

    expect(response.ok).toBe(true)
    expect(state.generation).toBe(1)
  })

  test('increments generation multiple times', async () => {
    const request: InvalidateRequest = {
      id: 'invalidate-2',
      type: 'invalidate',
    }

    await handleRequest(request, state, picker)
    await handleRequest({ ...request, id: 'invalidate-3' }, state, picker)
    await handleRequest({ ...request, id: 'invalidate-4' }, state, picker)

    expect(state.generation).toBe(3)
  })

  test('returns success response', async () => {
    const request: InvalidateRequest = {
      id: 'invalidate-5',
      type: 'invalidate',
    }

    const response = await handleRequest(request, state, picker)

    expect(response.ok).toBe(true)
    expect(response.id).toBe('invalidate-5')
    expect(response.error).toBeUndefined()
  })

  test('accepts optional root parameter', async () => {
    const request: InvalidateRequest = {
      id: 'invalidate-6',
      type: 'invalidate',
      root: '/some/specific/root',
    }

    const response = await handleRequest(request, state, picker)

    expect(response.ok).toBe(true)
    expect(state.generation).toBe(1)
  })
})

// ============================================================================
// handleRequest - Stop Tests
// ============================================================================

describe('handleRequest - stop', () => {
  let picker: FilePicker
  let state: DaemonState
  let dbCleanup: () => void
  let dbPath: string

  beforeEach(async () => {
    const temp = createTempDbPath()
    dbPath = temp.dbPath
    dbCleanup = temp.cleanup

    picker = await createFilePicker({ dbPath })
    state = createInitialState()
  })

  afterEach(async () => {
    await picker.close()
    dbCleanup()
  })

  test('returns success response', async () => {
    const request: StopRequest = {
      id: 'stop-1',
      type: 'stop',
    }

    const response = await handleRequest(request, state, picker)

    expect(response.ok).toBe(true)
    expect(response.id).toBe('stop-1')
    expect(response.error).toBeUndefined()
  })

  test('does not modify state', async () => {
    const request: StopRequest = {
      id: 'stop-2',
      type: 'stop',
    }

    const generationBefore = state.generation
    const startTimeBefore = state.startTime

    await handleRequest(request, state, picker)

    expect(state.generation).toBe(generationBefore)
    expect(state.startTime).toBe(startTimeBefore)
  })
})

// ============================================================================
// handleRequest - Request ID Propagation
// ============================================================================

describe('handleRequest - request ID propagation', () => {
  let picker: FilePicker
  let state: DaemonState
  let dbCleanup: () => void
  let dbPath: string

  beforeEach(async () => {
    const temp = createTempDbPath()
    dbPath = temp.dbPath
    dbCleanup = temp.cleanup

    picker = await createFilePicker({ dbPath })
    state = createInitialState()
  })

  afterEach(async () => {
    await picker.close()
    dbCleanup()
  })

  test('search response includes request ID', async () => {
    const request: SearchRequest = {
      id: 'unique-search-id-123',
      type: 'search',
      query: 'test',
    }

    const response = await handleRequest(request, state, picker)
    expect(response.id).toBe('unique-search-id-123')
  })

  test('health response includes request ID', async () => {
    const request: HealthRequest = {
      id: 'unique-health-id-456',
      type: 'health',
    }

    const response = await handleRequest(request, state, picker)
    expect(response.id).toBe('unique-health-id-456')
  })

  test('invalidate response includes request ID', async () => {
    const request: InvalidateRequest = {
      id: 'unique-invalidate-id-789',
      type: 'invalidate',
    }

    const response = await handleRequest(request, state, picker)
    expect(response.id).toBe('unique-invalidate-id-789')
  })

  test('stop response includes request ID', async () => {
    const request: StopRequest = {
      id: 'unique-stop-id-abc',
      type: 'stop',
    }

    const response = await handleRequest(request, state, picker)
    expect(response.id).toBe('unique-stop-id-abc')
  })
})
