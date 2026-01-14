/**
 * Tests for daemon generation tracking utilities.
 *
 * @module daemon/generation.test
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { Database } from 'bun:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  readGeneration,
  bumpGeneration,
  createGenerationTracker,
  checkGenerationChange,
  type GenerationState,
} from './generation'

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a temporary database for testing.
 */
function createTempDb(): { db: Database; cleanup: () => void } {
  const tempDir = mkdtempSync(join(tmpdir(), 'daemon-generation-test-'))
  const dbPath = join(tempDir, 'test.db')
  const db = new Database(dbPath, { create: true })

  return {
    db,
    cleanup: () => {
      try {
        db.close()
      } catch {
        // Ignore close errors
      }
      try {
        rmSync(tempDir, { recursive: true })
      } catch {
        // Ignore cleanup errors
      }
    },
  }
}

// ============================================================================
// readGeneration Tests
// ============================================================================

describe('readGeneration', () => {
  let db: Database
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDb()
    db = temp.db
    cleanup = temp.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  test('returns 0 for fresh database', () => {
    const generation = readGeneration(db)
    expect(generation).toBe(0)
  })

  test('returns current user_version', () => {
    db.exec('PRAGMA user_version = 42;')

    const generation = readGeneration(db)
    expect(generation).toBe(42)
  })
})

// ============================================================================
// bumpGeneration Tests
// ============================================================================

describe('bumpGeneration', () => {
  let db: Database
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDb()
    db = temp.db
    cleanup = temp.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  test('increments user_version', () => {
    expect(readGeneration(db)).toBe(0)

    const result = bumpGeneration(db)

    expect(result).toBe(1)
    expect(readGeneration(db)).toBe(1)
  })

  test('increments multiple times', () => {
    bumpGeneration(db)
    bumpGeneration(db)
    const result = bumpGeneration(db)

    expect(result).toBe(3)
    expect(readGeneration(db)).toBe(3)
  })

  test('increments from non-zero start', () => {
    db.exec('PRAGMA user_version = 100;')

    const result = bumpGeneration(db)

    expect(result).toBe(101)
    expect(readGeneration(db)).toBe(101)
  })
})

// ============================================================================
// createGenerationTracker Tests
// ============================================================================

describe('createGenerationTracker', () => {
  let db: Database
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDb()
    db = temp.db
    cleanup = temp.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  test('initializes with current version', () => {
    const tracker = createGenerationTracker(db)

    expect(tracker.current).toBe(0)
    expect(tracker.lastChecked).toBeLessThanOrEqual(Date.now())
    expect(tracker.lastChecked).toBeGreaterThan(Date.now() - 1000)
  })

  test('initializes with non-zero version', () => {
    db.exec('PRAGMA user_version = 50;')

    const tracker = createGenerationTracker(db)

    expect(tracker.current).toBe(50)
  })
})

// ============================================================================
// checkGenerationChange Tests
// ============================================================================

describe('checkGenerationChange', () => {
  let db: Database
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDb()
    db = temp.db
    cleanup = temp.cleanup
  })

  afterEach(() => {
    cleanup()
  })

  test('returns undefined when unchanged', () => {
    const state = createGenerationTracker(db)

    const result = checkGenerationChange(db, state)

    expect(result).toBeUndefined()
  })

  test('detects external change', () => {
    const state = createGenerationTracker(db)
    expect(state.current).toBe(0)

    // Simulate external generation bump
    db.exec('PRAGMA user_version = 5;')

    const result = checkGenerationChange(db, state)

    expect(result).toBe(5)
    expect(state.current).toBe(5)
  })

  test('updates lastChecked', async () => {
    const state = createGenerationTracker(db)
    const originalLastChecked = state.lastChecked

    await Bun.sleep(10)

    checkGenerationChange(db, state)

    expect(state.lastChecked).toBeGreaterThan(originalLastChecked)
  })

  test('returns undefined after consuming change', () => {
    const state = createGenerationTracker(db)

    // First change
    db.exec('PRAGMA user_version = 5;')
    const first = checkGenerationChange(db, state)
    expect(first).toBe(5)

    // No new change
    const second = checkGenerationChange(db, state)
    expect(second).toBeUndefined()
  })

  test('detects multiple sequential changes', () => {
    const state = createGenerationTracker(db)

    // First change
    db.exec('PRAGMA user_version = 1;')
    expect(checkGenerationChange(db, state)).toBe(1)

    // Second change
    db.exec('PRAGMA user_version = 10;')
    expect(checkGenerationChange(db, state)).toBe(10)

    // Third change
    db.exec('PRAGMA user_version = 100;')
    expect(checkGenerationChange(db, state)).toBe(100)
  })
})
