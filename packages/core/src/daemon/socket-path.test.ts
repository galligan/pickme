/**
 * Tests for daemon socket path resolution.
 *
 * Tests XDG compliance, fallback behavior, and secure directory creation.
 *
 * @module daemon/socket-path.test
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureSocketDir, getSocketDir, getSocketPath } from './socket-path'

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a temporary directory for testing.
 */
function createTempDir(): { path: string; cleanup: () => void } {
  const tempDir = mkdtempSync(join(tmpdir(), 'socket-path-test-'))
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

// ============================================================================
// getSocketDir Tests
// ============================================================================

describe('getSocketDir', () => {
  const originalXdgRuntimeDir = process.env.XDG_RUNTIME_DIR

  afterEach(() => {
    // Restore original env
    if (originalXdgRuntimeDir === undefined) {
      delete process.env.XDG_RUNTIME_DIR
    } else {
      process.env.XDG_RUNTIME_DIR = originalXdgRuntimeDir
    }
  })

  test('returns XDG_RUNTIME_DIR/pickme when env var is set', () => {
    process.env.XDG_RUNTIME_DIR = '/run/user/1000'
    const result = getSocketDir()
    expect(result).toBe('/run/user/1000/pickme')
  })

  test('returns /tmp fallback when XDG_RUNTIME_DIR not set', () => {
    delete process.env.XDG_RUNTIME_DIR
    const result = getSocketDir()
    const uid = process.getuid?.() ?? 0
    expect(result).toBe(`/tmp/pickme-${uid}`)
  })

  test('uses custom XDG path with pickme suffix', () => {
    process.env.XDG_RUNTIME_DIR = '/custom/runtime'
    const result = getSocketDir()
    expect(result).toBe('/custom/runtime/pickme')
  })

  test('handles empty XDG_RUNTIME_DIR as unset', () => {
    process.env.XDG_RUNTIME_DIR = ''
    const result = getSocketDir()
    const uid = process.getuid?.() ?? 0
    expect(result).toBe(`/tmp/pickme-${uid}`)
  })
})

// ============================================================================
// getSocketPath Tests
// ============================================================================

describe('getSocketPath', () => {
  const originalXdgRuntimeDir = process.env.XDG_RUNTIME_DIR

  afterEach(() => {
    if (originalXdgRuntimeDir === undefined) {
      delete process.env.XDG_RUNTIME_DIR
    } else {
      process.env.XDG_RUNTIME_DIR = originalXdgRuntimeDir
    }
  })

  test('returns socket path in XDG directory', () => {
    process.env.XDG_RUNTIME_DIR = '/run/user/1000'
    const result = getSocketPath()
    expect(result).toBe('/run/user/1000/pickme/pickme.sock')
  })

  test('returns socket path in /tmp fallback', () => {
    delete process.env.XDG_RUNTIME_DIR
    const result = getSocketPath()
    const uid = process.getuid?.() ?? 0
    expect(result).toBe(`/tmp/pickme-${uid}/pickme.sock`)
  })

  test('socket filename is predictable', () => {
    const result = getSocketPath()
    expect(result.endsWith('/pickme.sock')).toBe(true)
  })
})

// ============================================================================
// ensureSocketDir Tests
// ============================================================================

describe('ensureSocketDir', () => {
  let tempDir: { path: string; cleanup: () => void }
  const originalXdgRuntimeDir = process.env.XDG_RUNTIME_DIR

  beforeEach(() => {
    tempDir = createTempDir()
  })

  afterEach(() => {
    tempDir.cleanup()
    if (originalXdgRuntimeDir === undefined) {
      delete process.env.XDG_RUNTIME_DIR
    } else {
      process.env.XDG_RUNTIME_DIR = originalXdgRuntimeDir
    }
  })

  test('creates directory with 0700 permissions', () => {
    process.env.XDG_RUNTIME_DIR = tempDir.path
    ensureSocketDir()

    const socketDir = join(tempDir.path, 'pickme')
    const stat = statSync(socketDir)
    // Check mode is 0700 (owner rwx only)
    expect(stat.mode & 0o777).toBe(0o700)
  })

  test('succeeds if directory already exists with correct permissions', () => {
    process.env.XDG_RUNTIME_DIR = tempDir.path
    const socketDir = join(tempDir.path, 'pickme')

    // Pre-create directory with correct permissions
    mkdirSync(socketDir, { mode: 0o700 })

    // Should not throw
    expect(() => ensureSocketDir()).not.toThrow()
  })

  test('throws on existing directory with insecure permissions', () => {
    process.env.XDG_RUNTIME_DIR = tempDir.path
    const socketDir = join(tempDir.path, 'pickme')

    // Pre-create directory with insecure permissions (world readable)
    mkdirSync(socketDir, { mode: 0o755 })

    // Should throw due to insecure permissions
    expect(() => ensureSocketDir()).toThrow(/insecure permissions/)
  })

  test('throws on existing directory with group writable permissions', () => {
    process.env.XDG_RUNTIME_DIR = tempDir.path
    const socketDir = join(tempDir.path, 'pickme')

    // Pre-create directory with group write (insecure)
    mkdirSync(socketDir, { mode: 0o770 })

    // Should throw due to insecure permissions
    expect(() => ensureSocketDir()).toThrow(/insecure permissions/)
  })

  test('creates nested directories if needed', () => {
    // Use a nested path that does not exist
    const nestedPath = join(tempDir.path, 'nested', 'runtime')
    process.env.XDG_RUNTIME_DIR = nestedPath

    // Should create the full path including pickme subdirectory
    ensureSocketDir()

    const socketDir = join(nestedPath, 'pickme')
    const stat = statSync(socketDir)
    expect(stat.isDirectory()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o700)
  })

  test('returns the socket directory path', () => {
    process.env.XDG_RUNTIME_DIR = tempDir.path
    const result = ensureSocketDir()
    expect(result).toBe(join(tempDir.path, 'pickme'))
  })

  test('creates parent directory for custom socket path', () => {
    const customSocketPath = join(tempDir.path, 'custom', 'nested', 'daemon.sock')
    const result = ensureSocketDir(customSocketPath)

    // Should create the parent directory of the socket path
    const expectedDir = join(tempDir.path, 'custom', 'nested')
    expect(result).toBe(expectedDir)

    const stat = statSync(expectedDir)
    expect(stat.isDirectory()).toBe(true)
    expect(stat.mode & 0o777).toBe(0o700)
  })
})
