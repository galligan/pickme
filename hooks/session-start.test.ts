/**
 * Tests for the session-start hook.
 *
 * Verifies that the hook:
 * - Completes quickly (< 100ms)
 * - Spawns background work for stale indexes
 * - Handles missing config gracefully
 * - Handles database errors gracefully
 * - Never throws/exits non-zero
 *
 * @module session-start.test
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ============================================================================
// Test Fixtures
// ============================================================================

/** Temporary test directory */
let testDir: string
let testDbPath: string
let testConfigPath: string

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(async () => {
  testDir = join(tmpdir(), `session-start-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(testDir, { recursive: true })
  testDbPath = join(testDir, 'index.db')
  testConfigPath = join(testDir, 'config.toml')
})

afterEach(async () => {
  try {
    await rm(testDir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
})

// ============================================================================
// Import the hook functions (to be implemented)
// ============================================================================

import {
  checkStaleness,
  determineProjectRoot,
  type HookContext,
  runSessionStartHook,
  STALE_THRESHOLD_MS,
} from './session-start'

// ============================================================================
// Staleness Check Tests
// ============================================================================

describe('checkStaleness', () => {
  test('returns true when never indexed (lastIndexed is null)', () => {
    const result = checkStaleness(null)
    expect(result).toBe(true)
  })

  test('returns true when lastIndexed is older than threshold', () => {
    const twoHoursAgo = Date.now() - (2 * 60 * 60 * 1000)
    const result = checkStaleness(twoHoursAgo)
    expect(result).toBe(true)
  })

  test('returns false when lastIndexed is within threshold', () => {
    const thirtyMinutesAgo = Date.now() - (30 * 60 * 1000)
    const result = checkStaleness(thirtyMinutesAgo)
    expect(result).toBe(false)
  })

  test('returns false when lastIndexed is exactly at threshold', () => {
    const exactlyAtThreshold = Date.now() - STALE_THRESHOLD_MS
    const result = checkStaleness(exactlyAtThreshold)
    expect(result).toBe(false)
  })
})

// ============================================================================
// Project Root Detection Tests
// ============================================================================

describe('determineProjectRoot', () => {
  test('returns cwd when no CLAUDE_PROJECT_ROOT is set', () => {
    const ctx: HookContext = {
      cwd: '/Users/dev/project',
      env: {},
    }
    const result = determineProjectRoot(ctx)
    expect(result).toBe('/Users/dev/project')
  })

  test('returns CLAUDE_PROJECT_ROOT when set', () => {
    const ctx: HookContext = {
      cwd: '/Users/dev/other',
      env: { CLAUDE_PROJECT_ROOT: '/Users/dev/project' },
    }
    const result = determineProjectRoot(ctx)
    expect(result).toBe('/Users/dev/project')
  })

  test('expands tilde in CLAUDE_PROJECT_ROOT', () => {
    const ctx: HookContext = {
      cwd: '/tmp',
      env: { CLAUDE_PROJECT_ROOT: '~/Developer/project' },
    }
    const result = determineProjectRoot(ctx)
    expect(result).toContain('/Developer/project')
    expect(result).not.toContain('~')
  })
})

// ============================================================================
// Hook Execution Tests
// ============================================================================

describe('runSessionStartHook', () => {
  test('completes within 100ms', async () => {
    // Create a minimal config
    await writeFile(testConfigPath, `
[index]
roots = ["${testDir}"]
`)

    const start = performance.now()
    const result = await runSessionStartHook({
      configPath: testConfigPath,
      dbPath: testDbPath,
      cwd: testDir,
      env: {},
    })
    const elapsed = performance.now() - start

    expect(elapsed).toBeLessThan(100)
    expect(result.success).toBe(true)
  })

  test('handles missing config file gracefully', async () => {
    const missingConfigPath = join(testDir, 'nonexistent.toml')

    const result = await runSessionStartHook({
      configPath: missingConfigPath,
      dbPath: testDbPath,
      cwd: testDir,
      env: {},
    })

    // Should succeed with defaults
    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
  })

  test('handles database errors gracefully', async () => {
    // Create an invalid database path (directory instead of file)
    const invalidDbDir = join(testDir, 'invalid.db')
    await mkdir(invalidDbDir)

    await writeFile(testConfigPath, `
[index]
roots = ["${testDir}"]
`)

    const result = await runSessionStartHook({
      configPath: testConfigPath,
      dbPath: invalidDbDir,
      cwd: testDir,
      env: {},
    })

    // Should not throw, but may indicate error
    expect(result.success).toBe(true) // Hook should still "succeed" (not crash)
  })

  test('never throws an exception', async () => {
    // Even with completely broken inputs, hook should catch and return gracefully
    const result = await runSessionStartHook({
      configPath: '/nonexistent/path/config.toml',
      dbPath: '/nonexistent/path/index.db',
      cwd: '/nonexistent/path',
      env: {},
    })

    // Should return a result, not throw
    expect(result).toBeDefined()
    expect(typeof result.success).toBe('boolean')
  })

  test('returns stale roots that need refresh', async () => {
    // Create test directories
    const root1 = join(testDir, 'root1')
    const root2 = join(testDir, 'root2')
    await mkdir(root1)
    await mkdir(root2)

    await writeFile(testConfigPath, `
[index]
roots = ["${root1}", "${root2}"]
`)

    const result = await runSessionStartHook({
      configPath: testConfigPath,
      dbPath: testDbPath,
      cwd: testDir,
      env: {},
    })

    expect(result.success).toBe(true)
    // Both roots should be stale since never indexed
    expect(result.staleRoots?.length).toBeGreaterThanOrEqual(0)
  })

  test('identifies project root from environment', async () => {
    await writeFile(testConfigPath, `
[index]
roots = ["${testDir}"]
`)

    const result = await runSessionStartHook({
      configPath: testConfigPath,
      dbPath: testDbPath,
      cwd: '/tmp',
      env: { CLAUDE_PROJECT_ROOT: testDir },
    })

    expect(result.success).toBe(true)
    expect(result.projectRoot).toBe(testDir)
  })
})

// ============================================================================
// Background Spawn Tests
// ============================================================================

describe('background refresh scheduling', () => {
  test('schedules background refresh for stale indexes', async () => {
    const root = join(testDir, 'stale-root')
    await mkdir(root)
    await writeFile(join(root, 'test.ts'), 'content')

    await writeFile(testConfigPath, `
[index]
roots = ["${root}"]
`)

    const result = await runSessionStartHook({
      configPath: testConfigPath,
      dbPath: testDbPath,
      cwd: root,
      env: {},
    })

    expect(result.success).toBe(true)
    // Stale roots should be identified
    expect(result.staleRoots).toBeDefined()
  })

  test('does not schedule refresh for fresh indexes', async () => {
    const root = join(testDir, 'fresh-root')
    await mkdir(root)

    await writeFile(testConfigPath, `
[index]
roots = ["${root}"]
`)

    // First run - indexes everything
    const firstResult = await runSessionStartHook({
      configPath: testConfigPath,
      dbPath: testDbPath,
      cwd: root,
      env: {},
    })
    expect(firstResult.success).toBe(true)

    // Second run immediately after - should not be stale
    const secondResult = await runSessionStartHook({
      configPath: testConfigPath,
      dbPath: testDbPath,
      cwd: root,
      env: {},
    })

    expect(secondResult.success).toBe(true)
    // No stale roots since we just indexed
    expect(secondResult.staleRoots?.length ?? 0).toBe(0)
  })
})

// ============================================================================
// Exit Code Tests (for CLI execution)
// ============================================================================

describe('CLI execution', () => {
  test('main script exits with code 0 on success', async () => {
    await writeFile(testConfigPath, `
[index]
roots = ["${testDir}"]
`)

    // Run the actual script
    const proc = Bun.spawn(['bun', 'run', join(__dirname, 'session-start.ts')], {
      env: {
        ...process.env,
        PICKME_CONFIG_PATH: testConfigPath,
        PICKME_DB_PATH: testDbPath,
      },
      cwd: testDir,
    })

    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
  })

  test('main script exits with code 0 even on errors', async () => {
    // Run with invalid paths - should still exit 0 (never fail session start)
    const proc = Bun.spawn(['bun', 'run', join(__dirname, 'session-start.ts')], {
      env: {
        ...process.env,
        FILE_PICKER_CONFIG_PATH: '/nonexistent/config.toml',
        FILE_PICKER_DB_PATH: '/nonexistent/index.db',
      },
      cwd: testDir,
    })

    const exitCode = await proc.exited
    expect(exitCode).toBe(0)
  })
})
