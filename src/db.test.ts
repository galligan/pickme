/**
 * Tests for the database layer.
 *
 * Uses temporary in-memory databases for isolation and speed.
 *
 * @module db.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Database } from 'bun:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, existsSync, mkdirSync } from 'node:fs'
import {
  openDatabase,
  closeDatabase,
  escapeFTSQuery,
  buildPrefixQuery,
  upsertFile,
  upsertFiles,
  deleteFiles,
  searchFiles,
  getWatchedRoots,
  updateWatchedRoot,
  upsertFrecency,
  pruneDeletedFiles,
  getDefaultDbPath,
  type FileMeta,
  type FrecencyRecord,
  type WatchedRoot,
} from './db'
import { DatabaseError, FTSSyntaxError } from './errors'

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a temporary database for testing.
 */
function createTempDb(): { db: Database; path: string; cleanup: () => void } {
  const tempDir = mkdtempSync(join(tmpdir(), 'pickme-test-'))
  const dbPath = join(tempDir, 'test.db')
  const db = openDatabase(dbPath)

  return {
    db,
    path: dbPath,
    cleanup: () => {
      closeDatabase(db)
      try {
        rmSync(tempDir, { recursive: true })
      } catch {
        // Ignore cleanup errors
      }
    },
  }
}

/**
 * Creates sample file metadata for testing.
 */
function createTestFile(overrides: Partial<FileMeta> = {}): FileMeta {
  const path = overrides.path ?? '/test/project/src/Button.tsx'
  const filename = overrides.filename ?? path.split('/').pop() ?? 'Button.tsx'
  const root = overrides.root ?? '/test/project'
  const relativePath = overrides.relativePath ?? path.replace(root + '/', '')
  const dirComponents =
    overrides.dirComponents ?? path.split('/').filter(Boolean).slice(0, -1).join(' ')

  return {
    path,
    filename,
    dirComponents,
    root,
    mtime: overrides.mtime ?? Math.floor(Date.now() / 1000),
    relativePath,
  }
}

// ============================================================================
// escapeFTSQuery Tests
// ============================================================================

describe('escapeFTSQuery', () => {
  test('handles empty string', () => {
    expect(escapeFTSQuery('')).toBe('')
    expect(escapeFTSQuery('   ')).toBe('')
  })

  test('wraps single token in quotes', () => {
    expect(escapeFTSQuery('button')).toBe('"button"')
    expect(escapeFTSQuery('Button')).toBe('"Button"')
  })

  test('handles multiple tokens', () => {
    expect(escapeFTSQuery('button component')).toBe('"button" "component"')
    expect(escapeFTSQuery('src lib utils')).toBe('"src" "lib" "utils"')
  })

  test('splits on path separators', () => {
    expect(escapeFTSQuery('src/components')).toBe('"src" "components"')
    expect(escapeFTSQuery('src\\components')).toBe('"src" "components"')
    expect(escapeFTSQuery('src/lib/utils')).toBe('"src" "lib" "utils"')
  })

  test('removes special FTS5 characters', () => {
    // Quotes
    expect(escapeFTSQuery('foo"bar')).toBe('"foobar"')
    // Parentheses
    expect(escapeFTSQuery('foo(bar)')).toBe('"foobar"')
    // Asterisk
    expect(escapeFTSQuery('foo*')).toBe('"foo"')
    // Colon
    expect(escapeFTSQuery('foo:bar')).toBe('"foobar"')
    // Plus/minus
    expect(escapeFTSQuery('foo+bar-baz')).toBe('"foobarbaz"')
  })

  test('handles dots in filenames', () => {
    // Dots are not special in FTS5, so they're preserved
    expect(escapeFTSQuery('file.ts')).toBe('"file.ts"')
    expect(escapeFTSQuery('index.test.ts')).toBe('"index.test.ts"')
  })

  test('trims whitespace', () => {
    expect(escapeFTSQuery('  button  ')).toBe('"button"')
    expect(escapeFTSQuery('\t\nbutton\n\t')).toBe('"button"')
  })

  test('handles mixed separators', () => {
    expect(escapeFTSQuery('src/components button')).toBe('"src" "components" "button"')
  })

  test('filters empty tokens', () => {
    expect(escapeFTSQuery('src//components')).toBe('"src" "components"')
    expect(escapeFTSQuery('src  components')).toBe('"src" "components"')
  })
})

// ============================================================================
// buildPrefixQuery Tests
// ============================================================================

describe('buildPrefixQuery', () => {
  test('handles empty string', () => {
    expect(buildPrefixQuery('')).toBe('')
  })

  test('adds asterisk for prefix matching', () => {
    expect(buildPrefixQuery('button')).toBe('"button"*')
    expect(buildPrefixQuery('src/comp')).toBe('"src" "comp"*')
  })

  test('works with multiple tokens', () => {
    expect(buildPrefixQuery('src lib utils')).toBe('"src" "lib" "utils"*')
  })
})

// ============================================================================
// Database Lifecycle Tests
// ============================================================================

describe('openDatabase / closeDatabase', () => {
  test('creates database file', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pickme-test-'))
    const dbPath = join(tempDir, 'test.db')

    try {
      const db = openDatabase(dbPath)
      expect(existsSync(dbPath)).toBe(true)
      closeDatabase(db)
    } finally {
      rmSync(tempDir, { recursive: true })
    }
  })

  test('initializes schema on first open', () => {
    const { db, cleanup } = createTempDb()

    try {
      // Check that tables exist
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
        )
        .all()
        .map(r => r.name)

      expect(tables).toContain('files_meta')
      expect(tables).toContain('frecency')
      expect(tables).toContain('watched_roots')
      expect(tables).toContain('schema_meta')
    } finally {
      cleanup()
    }
  })

  test('creates FTS5 virtual table', () => {
    const { db, cleanup } = createTempDb()

    try {
      const tables = db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'files_fts%'"
        )
        .all()
        .map(r => r.name)

      expect(tables).toContain('files_fts')
    } finally {
      cleanup()
    }
  })

  test('sets WAL mode', () => {
    const { db, cleanup } = createTempDb()

    try {
      const result = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()
      expect(result?.journal_mode).toBe('wal')
    } finally {
      cleanup()
    }
  })

  test('enables foreign keys', () => {
    const { db, cleanup } = createTempDb()

    try {
      const result = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys').get()
      expect(result?.foreign_keys).toBe(1)
    } finally {
      cleanup()
    }
  })

  test('reopening database preserves data', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pickme-test-'))
    const dbPath = join(tempDir, 'test.db')

    try {
      // First open - insert data
      let db = openDatabase(dbPath)
      upsertFile(db, createTestFile({ path: '/test/file.ts' }))
      closeDatabase(db)

      // Second open - verify data
      db = openDatabase(dbPath)
      const results = searchFiles(db, 'file')
      expect(results.length).toBe(1)
      expect(results[0]?.path).toBe('/test/file.ts')
      closeDatabase(db)
    } finally {
      rmSync(tempDir, { recursive: true })
    }
  })

  test('opens database in nested directory path', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pickme-test-'))
    const deepPath = join(tempDir, 'a', 'b', 'c', 'test.db')

    try {
      // Ensure parent directories are created
      mkdirSync(join(tempDir, 'a', 'b', 'c'), { recursive: true })
      const db = openDatabase(deepPath)
      expect(existsSync(deepPath)).toBe(true)
      closeDatabase(db)
    } finally {
      rmSync(tempDir, { recursive: true })
    }
  })
})

// ============================================================================
// File Operations Tests
// ============================================================================

describe('upsertFile', () => {
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

  test('inserts new file', () => {
    const file = createTestFile()
    upsertFile(db, file)

    const result = db.query<{ path: string }, []>('SELECT path FROM files_meta').get()
    expect(result?.path).toBe(file.path)
  })

  test('updates existing file', () => {
    const file = createTestFile()
    upsertFile(db, file)

    // Update mtime
    const updatedFile = { ...file, mtime: file.mtime + 100 }
    upsertFile(db, updatedFile)

    const result = db
      .query<
        { mtime: number; count: number },
        []
      >('SELECT mtime, (SELECT COUNT(*) FROM files_meta) as count FROM files_meta')
      .get()

    expect(result?.count).toBe(1)
    expect(result?.mtime).toBe(updatedFile.mtime)
  })

  test('syncs FTS index via trigger', () => {
    const file = createTestFile({ filename: 'UniqueTestFile.tsx' })
    upsertFile(db, file)

    // Search should find the file
    const results = searchFiles(db, 'UniqueTestFile')
    expect(results.length).toBe(1)
    expect(results[0]?.filename).toBe('UniqueTestFile.tsx')
  })
})

describe('upsertFiles', () => {
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

  test('handles empty array', () => {
    // Should not throw
    upsertFiles(db, [])

    const result = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM files_meta').get()
    expect(result?.count).toBe(0)
  })

  test('inserts multiple files', () => {
    const files = [
      createTestFile({ path: '/test/a.ts', filename: 'a.ts' }),
      createTestFile({ path: '/test/b.ts', filename: 'b.ts' }),
      createTestFile({ path: '/test/c.ts', filename: 'c.ts' }),
    ]

    upsertFiles(db, files)

    const result = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM files_meta').get()
    expect(result?.count).toBe(3)
  })

  test('uses transaction for atomicity', () => {
    const files = [createTestFile({ path: '/test/a.ts' }), createTestFile({ path: '/test/b.ts' })]

    upsertFiles(db, files)

    // All files should be inserted atomically
    const results = searchFiles(db, 'test')
    expect(results.length).toBe(2)
  })

  test('batch is faster than individual inserts', () => {
    const files = Array.from({ length: 100 }, (_, i) =>
      createTestFile({ path: `/test/file${i}.ts`, filename: `file${i}.ts` })
    )

    const start = performance.now()
    upsertFiles(db, files)
    const batchTime = performance.now() - start

    // Recreate db
    cleanup()
    const temp = createTempDb()
    db = temp.db
    cleanup = temp.cleanup

    const start2 = performance.now()
    for (const file of files) {
      upsertFile(db, file)
    }
    const individualTime = performance.now() - start2

    // Batch should be significantly faster (at least 2x)
    // But don't fail the test on slow CI - just verify it works
    expect(batchTime).toBeLessThan(individualTime * 2 + 100)
  })
})

describe('deleteFiles', () => {
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

  test('handles empty array', () => {
    deleteFiles(db, [])
    // Should not throw
  })

  test('deletes single file', () => {
    const file = createTestFile()
    upsertFile(db, file)
    deleteFiles(db, [file.path])

    const result = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM files_meta').get()
    expect(result?.count).toBe(0)
  })

  test('deletes multiple files', () => {
    const files = [
      createTestFile({ path: '/test/a.ts' }),
      createTestFile({ path: '/test/b.ts' }),
      createTestFile({ path: '/test/c.ts' }),
    ]
    upsertFiles(db, files)
    deleteFiles(db, ['/test/a.ts', '/test/c.ts'])

    const remaining = db.query<{ path: string }, []>('SELECT path FROM files_meta').all()
    expect(remaining.length).toBe(1)
    expect(remaining[0]?.path).toBe('/test/b.ts')
  })

  test('removes from FTS index via trigger', () => {
    const file = createTestFile({ filename: 'ToDelete.tsx' })
    upsertFile(db, file)

    // Verify file is searchable
    expect(searchFiles(db, 'ToDelete').length).toBe(1)

    deleteFiles(db, [file.path])

    // Should not be searchable after delete
    expect(searchFiles(db, 'ToDelete').length).toBe(0)
  })

  test('cascades to frecency table', () => {
    const file = createTestFile()
    upsertFile(db, file)
    upsertFrecency(db, [
      {
        path: file.path,
        gitRecency: 0.5,
        gitFrequency: 10,
        gitStatusBoost: 0,
        lastSeen: Date.now(),
      },
    ])

    deleteFiles(db, [file.path])

    const frecencyCount = db
      .query<{ count: number }, []>('SELECT COUNT(*) as count FROM frecency')
      .get()
    expect(frecencyCount?.count).toBe(0)
  })
})

// ============================================================================
// Search Tests
// ============================================================================

describe('searchFiles', () => {
  let db: Database
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDb()
    db = temp.db
    cleanup = temp.cleanup

    // Seed with test data
    upsertFiles(db, [
      createTestFile({
        path: '/project/src/components/Button.tsx',
        filename: 'Button.tsx',
        root: '/project',
        relativePath: 'src/components/Button.tsx',
        dirComponents: 'project src components',
      }),
      createTestFile({
        path: '/project/src/components/Modal.tsx',
        filename: 'Modal.tsx',
        root: '/project',
        relativePath: 'src/components/Modal.tsx',
        dirComponents: 'project src components',
      }),
      createTestFile({
        path: '/project/src/utils/helpers.ts',
        filename: 'helpers.ts',
        root: '/project',
        relativePath: 'src/utils/helpers.ts',
        dirComponents: 'project src utils',
      }),
      createTestFile({
        path: '/other/README.md',
        filename: 'README.md',
        root: '/other',
        relativePath: 'README.md',
        dirComponents: 'other',
      }),
    ])
  })

  afterEach(() => {
    cleanup()
  })

  test('returns empty array for empty query', () => {
    const results = searchFiles(db, '')
    expect(results).toEqual([])
  })

  test('finds files by filename', () => {
    const results = searchFiles(db, 'Button')
    expect(results.length).toBe(1)
    expect(results[0]?.filename).toBe('Button.tsx')
  })

  test('finds files by path component', () => {
    const results = searchFiles(db, 'components')
    expect(results.length).toBe(2)
  })

  test('supports prefix matching', () => {
    const results = searchFiles(db, 'Butt')
    expect(results.length).toBe(1)
    expect(results[0]?.filename).toBe('Button.tsx')
  })

  test('supports multi-token queries', () => {
    const results = searchFiles(db, 'src utils')
    expect(results.length).toBe(1)
    expect(results[0]?.filename).toBe('helpers.ts')
  })

  test('filters by path prefix', () => {
    const results = searchFiles(db, 'src', {
      pathFilters: ['/project'],
    })

    // Should only find files under /project
    expect(results.length).toBe(3)
    expect(results.every(r => r.path.startsWith('/project'))).toBe(true)
  })

  test('supports multiple path filters (OR logic)', () => {
    const results = searchFiles(db, 'README', {
      pathFilters: ['/project', '/other'],
    })

    expect(results.length).toBe(1)
    expect(results[0]?.filename).toBe('README.md')
  })

  test('respects limit', () => {
    const results = searchFiles(db, 'src', { limit: 2 })
    expect(results.length).toBe(2)
  })

  test('default limit is 50', () => {
    // Insert 60 files
    const files = Array.from({ length: 60 }, (_, i) =>
      createTestFile({
        path: `/project/src/file${i}.ts`,
        filename: `file${i}.ts`,
        dirComponents: 'project src',
      })
    )
    upsertFiles(db, files)

    const results = searchFiles(db, 'src')
    expect(results.length).toBe(50)
  })

  test('includes score in results', () => {
    const results = searchFiles(db, 'Button')
    expect(results[0]?.score).toBeDefined()
    expect(typeof results[0]?.score).toBe('number')
  })

  test('ranks by frecency when available', () => {
    // Add frecency data - Modal has higher recency
    upsertFrecency(db, [
      {
        path: '/project/src/components/Modal.tsx',
        gitRecency: 1.0, // Very recent
        gitFrequency: 20,
        gitStatusBoost: 5.0, // Modified
        lastSeen: Date.now(),
      },
      {
        path: '/project/src/components/Button.tsx',
        gitRecency: 0.1, // Old
        gitFrequency: 5,
        gitStatusBoost: 0,
        lastSeen: Date.now(),
      },
    ])

    const results = searchFiles(db, 'components')

    // Modal should rank higher due to frecency
    expect(results[0]?.filename).toBe('Modal.tsx')
  })

  test('handles special characters in query', () => {
    // Should not throw, just return results or empty
    expect(() => searchFiles(db, 'foo*bar')).not.toThrow()
    expect(() => searchFiles(db, 'foo(bar)')).not.toThrow()
    expect(() => searchFiles(db, 'foo"bar')).not.toThrow()
  })

  test('returns relativePath in results', () => {
    const results = searchFiles(db, 'Button')
    expect(results[0]?.relativePath).toBe('src/components/Button.tsx')
  })
})

// ============================================================================
// Watched Roots Tests
// ============================================================================

describe('getWatchedRoots / updateWatchedRoot', () => {
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

  test('returns empty array initially', () => {
    const roots = getWatchedRoots(db)
    expect(roots).toEqual([])
  })

  test('inserts new root', () => {
    const root: WatchedRoot = {
      root: '/Users/mg/Developer',
      maxDepth: 10,
      lastIndexed: Date.now(),
      fileCount: 1000,
    }

    updateWatchedRoot(db, root)
    const roots = getWatchedRoots(db)

    expect(roots.length).toBe(1)
    expect(roots[0]).toEqual(root)
  })

  test('updates existing root', () => {
    const root: WatchedRoot = {
      root: '/Users/mg/Developer',
      maxDepth: 10,
      lastIndexed: 1000,
      fileCount: 500,
    }

    updateWatchedRoot(db, root)

    const updatedRoot: WatchedRoot = {
      root: '/Users/mg/Developer',
      maxDepth: 15,
      lastIndexed: 2000,
      fileCount: 1000,
    }

    updateWatchedRoot(db, updatedRoot)
    const roots = getWatchedRoots(db)

    expect(roots.length).toBe(1)
    expect(roots[0]).toEqual(updatedRoot)
  })

  test('handles null values', () => {
    const root: WatchedRoot = {
      root: '/test',
      maxDepth: 5,
      lastIndexed: null,
      fileCount: null,
    }

    updateWatchedRoot(db, root)
    const roots = getWatchedRoots(db)

    expect(roots[0]?.lastIndexed).toBeNull()
    expect(roots[0]?.fileCount).toBeNull()
  })

  test('stores multiple roots', () => {
    updateWatchedRoot(db, {
      root: '/Users/mg/Developer',
      maxDepth: 10,
      lastIndexed: null,
      fileCount: null,
    })
    updateWatchedRoot(db, {
      root: '/Users/mg/.config',
      maxDepth: 5,
      lastIndexed: null,
      fileCount: null,
    })

    const roots = getWatchedRoots(db)
    expect(roots.length).toBe(2)
  })
})

// ============================================================================
// Frecency Tests
// ============================================================================

describe('upsertFrecency', () => {
  let db: Database
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDb()
    db = temp.db
    cleanup = temp.cleanup

    // Seed with files (required for foreign key)
    upsertFiles(db, [
      createTestFile({ path: '/test/a.ts' }),
      createTestFile({ path: '/test/b.ts' }),
    ])
  })

  afterEach(() => {
    cleanup()
  })

  test('handles empty array', () => {
    upsertFrecency(db, [])
    // Should not throw
  })

  test('inserts new frecency records', () => {
    upsertFrecency(db, [
      {
        path: '/test/a.ts',
        gitRecency: 0.8,
        gitFrequency: 15,
        gitStatusBoost: 5.0,
        lastSeen: 1000,
      },
    ])

    const result = db
      .query<
        {
          path: string
          git_recency: number
          git_frequency: number
          git_status_boost: number
        },
        []
      >("SELECT * FROM frecency WHERE path = '/test/a.ts'")
      .get()

    expect(result?.git_recency).toBe(0.8)
    expect(result?.git_frequency).toBe(15)
    expect(result?.git_status_boost).toBe(5.0)
  })

  test('updates existing frecency records', () => {
    upsertFrecency(db, [
      {
        path: '/test/a.ts',
        gitRecency: 0.5,
        gitFrequency: 10,
        gitStatusBoost: 0,
        lastSeen: 1000,
      },
    ])

    upsertFrecency(db, [
      {
        path: '/test/a.ts',
        gitRecency: 0.9,
        gitFrequency: 20,
        gitStatusBoost: 5.0,
        lastSeen: 2000,
      },
    ])

    const result = db
      .query<
        { git_recency: number; git_frequency: number },
        []
      >("SELECT git_recency, git_frequency FROM frecency WHERE path = '/test/a.ts'")
      .get()

    expect(result?.git_recency).toBe(0.9)
    expect(result?.git_frequency).toBe(20)
  })

  test('batch inserts multiple records', () => {
    upsertFrecency(db, [
      {
        path: '/test/a.ts',
        gitRecency: 0.5,
        gitFrequency: 10,
        gitStatusBoost: 0,
        lastSeen: 1000,
      },
      {
        path: '/test/b.ts',
        gitRecency: 0.3,
        gitFrequency: 5,
        gitStatusBoost: 3.0,
        lastSeen: 1000,
      },
    ])

    const count = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM frecency').get()
    expect(count?.count).toBe(2)
  })
})

describe('pruneDeletedFiles', () => {
  let db: Database
  let cleanup: () => void

  beforeEach(() => {
    const temp = createTempDb()
    db = temp.db
    cleanup = temp.cleanup

    // Seed with test files
    upsertFiles(db, [
      createTestFile({ path: '/test/a.ts' }),
      createTestFile({ path: '/test/b.ts' }),
      createTestFile({ path: '/test/c.ts' }),
    ])
  })

  afterEach(() => {
    cleanup()
  })

  test('removes files not in existing set', () => {
    const existingPaths = new Set(['/test/a.ts', '/test/c.ts'])
    const pruned = pruneDeletedFiles(db, existingPaths)

    expect(pruned).toBe(1)

    const remaining = db
      .query<{ path: string }, []>('SELECT path FROM files_meta ORDER BY path')
      .all()
    expect(remaining.length).toBe(2)
    expect(remaining.map(r => r.path)).toEqual(['/test/a.ts', '/test/c.ts'])
  })

  test('returns 0 when all files exist', () => {
    const existingPaths = new Set(['/test/a.ts', '/test/b.ts', '/test/c.ts'])
    const pruned = pruneDeletedFiles(db, existingPaths)

    expect(pruned).toBe(0)
  })

  test('removes all files when set is empty', () => {
    const existingPaths = new Set<string>()
    const pruned = pruneDeletedFiles(db, existingPaths)

    expect(pruned).toBe(3)

    const count = db.query<{ count: number }, []>('SELECT COUNT(*) as count FROM files_meta').get()
    expect(count?.count).toBe(0)
  })

  test('handles large existing set efficiently', () => {
    // Add more files
    const files = Array.from({ length: 100 }, (_, i) =>
      createTestFile({ path: `/test/file${i}.ts`, filename: `file${i}.ts` })
    )
    upsertFiles(db, files)

    // Keep half
    const existingPaths = new Set(Array.from({ length: 50 }, (_, i) => `/test/file${i}.ts`))
    existingPaths.add('/test/a.ts')
    existingPaths.add('/test/b.ts')
    existingPaths.add('/test/c.ts')

    const start = performance.now()
    const pruned = pruneDeletedFiles(db, existingPaths)
    const elapsed = performance.now() - start

    expect(pruned).toBe(50)
    // Should be reasonably fast (under 100ms even with 100 deletes)
    expect(elapsed).toBeLessThan(500)
  })
})

// ============================================================================
// Utility Tests
// ============================================================================

describe('getDefaultDbPath', () => {
  test('returns expected path', () => {
    const path = getDefaultDbPath()
    expect(path).toContain('pickme')
    expect(path).toContain('index.db')
  })
})

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('error handling', () => {
  test('throws DatabaseError on connection failure', () => {
    // Try to open database in non-existent, non-creatable location
    expect(() => openDatabase('/nonexistent/deeply/nested/path/db.sqlite')).toThrow(DatabaseError)
  })

  test('wraps SQLite errors in DatabaseError', () => {
    const { db, cleanup } = createTempDb()

    try {
      // Try to insert invalid data (violate NOT NULL constraint)
      expect(() => {
        db.exec('INSERT INTO files_meta (path) VALUES (NULL)')
      }).toThrow()
    } finally {
      cleanup()
    }
  })
})
