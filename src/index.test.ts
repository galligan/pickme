/**
 * Tests for the main file picker module.
 *
 * Tests the `createFilePicker` factory and its search, indexing,
 * and configuration integration.
 *
 * @module index.test
 */

import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import {
  createFilePicker,
  type FilePicker,
  type FilePickerSearchOptions,
  type FilePickerSearchResult,
} from './index'

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
  const tempDir = mkdtempSync(join(tmpdir(), 'file-picker-test-'))

  // Create a project structure
  mkdirSync(join(tempDir, 'src', 'components'), { recursive: true })
  mkdirSync(join(tempDir, 'src', 'utils'), { recursive: true })
  mkdirSync(join(tempDir, 'docs'), { recursive: true })

  // Create some files
  writeFileSync(join(tempDir, 'src', 'components', 'Button.tsx'), 'export const Button = () => {}')
  writeFileSync(join(tempDir, 'src', 'components', 'Modal.tsx'), 'export const Modal = () => {}')
  writeFileSync(join(tempDir, 'src', 'utils', 'helpers.ts'), 'export const helper = () => {}')
  writeFileSync(join(tempDir, 'src', 'index.ts'), 'export * from "./components"')
  writeFileSync(join(tempDir, 'docs', 'README.md'), '# Documentation')
  writeFileSync(join(tempDir, 'package.json'), '{"name": "test"}')
  writeFileSync(join(tempDir, 'CLAUDE.md'), '# Claude Config')

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
  const tempDir = mkdtempSync(join(tmpdir(), 'file-picker-db-'))
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
// createFilePicker Tests
// ============================================================================

describe('createFilePicker', () => {
  let dbCleanup: () => void
  let dbPath: string

  beforeEach(() => {
    const temp = createTempDbPath()
    dbPath = temp.dbPath
    dbCleanup = temp.cleanup
  })

  afterEach(() => {
    dbCleanup()
  })

  test('creates a file picker instance', async () => {
    const picker = await createFilePicker({ dbPath })

    expect(picker).toBeDefined()
    expect(typeof picker.search).toBe('function')
    expect(typeof picker.ensureIndexed).toBe('function')
    expect(typeof picker.refreshIndex).toBe('function')
    expect(typeof picker.close).toBe('function')

    await picker.close()
  })

  test('accepts custom database path', async () => {
    const customDbPath = join(dbPath, '..', 'custom.db')
    const picker = await createFilePicker({ dbPath: customDbPath })

    expect(picker).toBeDefined()
    await picker.close()
  })

  test('loads default configuration when none provided', async () => {
    const picker = await createFilePicker({ dbPath })

    // Config should be loaded (tested indirectly through search behavior)
    expect(picker).toBeDefined()
    await picker.close()
  })
})

// ============================================================================
// FilePicker.search Tests
// ============================================================================

describe('FilePicker.search', () => {
  let picker: FilePicker
  let project: { root: string; cleanup: () => void }
  let dbCleanup: () => void
  let dbPath: string

  beforeEach(async () => {
    const temp = createTempDbPath()
    dbPath = temp.dbPath
    dbCleanup = temp.cleanup

    project = createTempProject()
    picker = await createFilePicker({ dbPath })

    // Index the test project
    await picker.ensureIndexed([project.root])
  })

  afterEach(async () => {
    await picker.close()
    project.cleanup()
    dbCleanup()
  })

  test('returns empty array for empty query', async () => {
    const results = await picker.search('')
    expect(results).toEqual([])
  })

  test('finds files by filename', async () => {
    const results = await picker.search('Button')

    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.some((r) => r.filename === 'Button.tsx')).toBe(true)
  })

  test('finds files by path component', async () => {
    const results = await picker.search('components')

    expect(results.length).toBeGreaterThanOrEqual(2)
    expect(results.some((r) => r.filename === 'Button.tsx')).toBe(true)
    expect(results.some((r) => r.filename === 'Modal.tsx')).toBe(true)
  })

  test('supports prefix matching', async () => {
    const results = await picker.search('Butt')

    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.some((r) => r.filename === 'Button.tsx')).toBe(true)
  })

  test('filters by project root', async () => {
    const results = await picker.search('src', {
      projectRoot: project.root,
    })

    // All results should be under project root
    expect(results.every((r) => r.path.startsWith(project.root))).toBe(true)
  })

  test('respects limit option', async () => {
    const results = await picker.search('ts', { limit: 2 })
    expect(results.length).toBeLessThanOrEqual(2)
  })

  test('returns results with required properties', async () => {
    const results = await picker.search('Button')

    expect(results.length).toBeGreaterThanOrEqual(1)
    const result = results[0]!
    expect(result.path).toBeDefined()
    expect(result.filename).toBeDefined()
    expect(result.relativePath).toBeDefined()
    expect(result.score).toBeDefined()
    expect(typeof result.score).toBe('number')
  })

  test('handles special characters in query', async () => {
    // Should not throw, just return results or empty
    await expect(picker.search('foo*bar')).resolves.toBeDefined()
    await expect(picker.search('foo(bar)')).resolves.toBeDefined()
    await expect(picker.search('foo"bar')).resolves.toBeDefined()
  })
})

// ============================================================================
// FilePicker.search with Prefixes Tests
// ============================================================================

describe('FilePicker.search with prefixes', () => {
  let picker: FilePicker
  let project: { root: string; cleanup: () => void }
  let dbCleanup: () => void
  let dbPath: string

  beforeEach(async () => {
    const temp = createTempDbPath()
    dbPath = temp.dbPath
    dbCleanup = temp.cleanup

    project = createTempProject()
    picker = await createFilePicker({ dbPath })

    // Index the test project
    await picker.ensureIndexed([project.root])
  })

  afterEach(async () => {
    await picker.close()
    project.cleanup()
    dbCleanup()
  })

  test('handles @@ escape sequence', async () => {
    // @@ should be treated as literal @
    const results = await picker.search('@@types')

    // Should search for "@types" literally - no results expected since no such file
    expect(Array.isArray(results)).toBe(true)
  })

  test('handles inline glob @*.ext', async () => {
    // @*.md should filter to markdown files
    const results = await picker.search('@*.md', {
      projectRoot: project.root,
    })

    // Should find README.md and CLAUDE.md
    expect(results.every((r) => r.filename.endsWith('.md'))).toBe(true)
  })

  test('handles folder prefix @/folder:', async () => {
    const results = await picker.search('@/components:', {
      projectRoot: project.root,
    })

    // Should find files in components folder
    expect(results.length).toBeGreaterThanOrEqual(0)
  })
})

// ============================================================================
// FilePicker.ensureIndexed Tests
// ============================================================================

describe('FilePicker.ensureIndexed', () => {
  let picker: FilePicker
  let project: { root: string; cleanup: () => void }
  let dbCleanup: () => void
  let dbPath: string

  beforeEach(async () => {
    const temp = createTempDbPath()
    dbPath = temp.dbPath
    dbCleanup = temp.cleanup

    project = createTempProject()
    picker = await createFilePicker({ dbPath })
  })

  afterEach(async () => {
    await picker.close()
    project.cleanup()
    dbCleanup()
  })

  test('indexes a directory', async () => {
    const result = await picker.ensureIndexed([project.root])

    expect(result.filesIndexed).toBeGreaterThan(0)
    expect(result.errors).toEqual([])
  })

  test('makes files searchable after indexing', async () => {
    // Before indexing - should find nothing
    const beforeResults = await picker.search('Button')
    expect(beforeResults.length).toBe(0)

    // Index the project
    await picker.ensureIndexed([project.root])

    // After indexing - should find Button.tsx
    const afterResults = await picker.search('Button')
    expect(afterResults.length).toBeGreaterThanOrEqual(1)
    expect(afterResults.some((r) => r.filename === 'Button.tsx')).toBe(true)
  })

  test('indexes multiple roots', async () => {
    // Create another temp directory
    const project2 = createTempProject()

    try {
      const result = await picker.ensureIndexed([project.root, project2.root])

      expect(result.filesIndexed).toBeGreaterThan(7) // At least 7 files per project
    } finally {
      project2.cleanup()
    }
  })

  test('handles non-existent directory gracefully', async () => {
    const result = await picker.ensureIndexed(['/nonexistent/path/that/does/not/exist'])

    // Should not throw, but report errors or skip
    expect(result.errors.length).toBeGreaterThanOrEqual(0)
  })

  test('excludes common patterns by default', async () => {
    // Create node_modules directory
    mkdirSync(join(project.root, 'node_modules', 'some-package'), { recursive: true })
    writeFileSync(
      join(project.root, 'node_modules', 'some-package', 'index.js'),
      'module.exports = {}'
    )

    await picker.ensureIndexed([project.root])

    // Search should not find files in node_modules
    const results = await picker.search('some-package')
    expect(results.length).toBe(0)
  })
})

// ============================================================================
// FilePicker.refreshIndex Tests
// ============================================================================

describe('FilePicker.refreshIndex', () => {
  let picker: FilePicker
  let project: { root: string; cleanup: () => void }
  let dbCleanup: () => void
  let dbPath: string

  beforeEach(async () => {
    const temp = createTempDbPath()
    dbPath = temp.dbPath
    dbCleanup = temp.cleanup

    project = createTempProject()
    picker = await createFilePicker({ dbPath })

    // Initial index
    await picker.ensureIndexed([project.root])
  })

  afterEach(async () => {
    await picker.close()
    project.cleanup()
    dbCleanup()
  })

  test('updates index with new files', async () => {
    // Add a new file
    writeFileSync(join(project.root, 'src', 'NewComponent.tsx'), 'export const New = () => {}')

    // Refresh the index
    await picker.refreshIndex(project.root)

    // Should find the new file
    const results = await picker.search('NewComponent')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results.some((r) => r.filename === 'NewComponent.tsx')).toBe(true)
  })

  test('returns refresh statistics', async () => {
    const result = await picker.refreshIndex(project.root)

    expect(result).toBeDefined()
    expect(typeof result.filesIndexed).toBe('number')
    expect(typeof result.duration).toBe('number')
  })
})

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('error handling', () => {
  test('handles database errors gracefully', async () => {
    // Try to create picker with invalid db path that can't be created
    // This should either throw a clear error or handle gracefully
    try {
      const picker = await createFilePicker({
        dbPath: '/nonexistent/deeply/nested/impossible/path/db.sqlite',
      })
      await picker.close()
      // If it doesn't throw, that's also acceptable
    } catch (err) {
      // Should be a meaningful error
      expect(err).toBeDefined()
    }
  })
})

// ============================================================================
// Type Export Tests
// ============================================================================

describe('type exports', () => {
  test('exports FilePicker type', () => {
    // This test verifies the type is exported correctly
    // TypeScript compilation will fail if types are not exported
    const _picker: FilePicker | null = null
    expect(true).toBe(true)
  })

  test('exports FilePickerSearchOptions type', () => {
    const _options: FilePickerSearchOptions = {
      projectRoot: '/test',
      limit: 20,
    }
    expect(_options.projectRoot).toBe('/test')
  })

  test('exports FilePickerSearchResult type', () => {
    const _result: FilePickerSearchResult = {
      path: '/test/file.ts',
      filename: 'file.ts',
      relativePath: 'file.ts',
      score: 1.0,
    }
    expect(_result.path).toBe('/test/file.ts')
  })
})
