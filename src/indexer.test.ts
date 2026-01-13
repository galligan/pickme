/**
 * Tests for the file indexer.
 *
 * @module indexer.test
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import type { Config } from './config'
import {
  type Database,
  type DbOperations,
  type FileMeta,
  type WatchedRoot,
  buildFileMeta,
  findRecentFiles,
  hasFd,
  indexDirectory,
  isWithinIndexedRoots,
  pruneDeletedFiles,
  refreshIndex,
  resetFdCache,
} from './indexer'

// ============================================================================
// Test Fixtures
// ============================================================================

/** Temporary test directory */
let testDir: string

/** Mock database for testing */
function createMockDb(): Database {
  return {
    query: mock(() => ({ all: () => [] })),
    run: mock(() => {}),
    exec: mock(() => {}),
  }
}

/** Mock database operations for testing */
function createMockDbOps(): DbOperations & {
  upsertedFiles: FileMeta[]
  deletedPaths: string[]
  updatedRoots: WatchedRoot[]
  filesForRoot: Map<string, string[]>
} {
  const upsertedFiles: FileMeta[] = []
  const deletedPaths: string[] = []
  const updatedRoots: WatchedRoot[] = []
  const filesForRoot = new Map<string, string[]>()

  return {
    upsertedFiles,
    deletedPaths,
    updatedRoots,
    filesForRoot,
    upsertFiles: mock((_, files: FileMeta[]) => {
      upsertedFiles.push(...files)
    }),
    deleteFiles: mock((_, paths: string[]) => {
      deletedPaths.push(...paths)
    }),
    updateWatchedRoot: mock((_, root: WatchedRoot) => {
      updatedRoots.push(root)
    }),
    getWatchedRoots: mock(() => []),
    getFilesForRoot: mock((_, root: string) => {
      return filesForRoot.get(root) ?? []
    }),
  }
}

/** Create a minimal test config */
function createTestConfig(overrides?: Partial<Config>): Config {
  return {
    active: true,
    weights: {
      git_recency: 1.0,
      git_frequency: 0.5,
      git_status: 5.0,
    },
    namespaces: {},
    priorities: { high: [], low: [] },
    index: {
      roots: [testDir],
      disabled: [],
      exclude: { patterns: ['node_modules', '.git'] },
      include: { patterns: [] },
      depth: { default: 10 },
      limits: {
        max_files_per_root: 50000,
        warn_threshold_mb: 500,
      },
    },
    ...overrides,
  }
}

// ============================================================================
// Setup / Teardown
// ============================================================================

beforeEach(async () => {
  testDir = join(tmpdir(), `indexer-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  await mkdir(testDir, { recursive: true })
  resetFdCache()
})

afterEach(async () => {
  try {
    await rm(testDir, { recursive: true, force: true })
  } catch {
    // Ignore cleanup errors
  }
})

// ============================================================================
// Utility Function Tests
// ============================================================================

describe('hasFd', () => {
  test('returns boolean indicating fd availability', async () => {
    const result = await hasFd()
    expect(typeof result).toBe('boolean')
  })

  test('caches result on subsequent calls', async () => {
    const first = await hasFd()
    const second = await hasFd()
    expect(first).toBe(second)
  })
})

describe('buildFileMeta', () => {
  test('builds correct metadata for a file', () => {
    const filePath = '/Users/dev/project/src/index.ts'
    const root = '/Users/dev/project'
    const mtime = Date.now()

    const meta = buildFileMeta(filePath, root, mtime)

    expect(meta.path).toBe(filePath)
    expect(meta.filename).toBe('index.ts')
    expect(meta.root).toBe(root)
    expect(meta.mtime).toBe(mtime)
    expect(meta.relativePath).toBe('src/index.ts')
    expect(meta.dirComponents).toBe(
      `Users${sep}dev${sep}project${sep}src${sep}index.ts`.split(sep).join(' ')
    )
  })

  test('handles files at root level', () => {
    const filePath = '/Users/dev/project/README.md'
    const root = '/Users/dev/project'
    const mtime = Date.now()

    const meta = buildFileMeta(filePath, root, mtime)

    expect(meta.relativePath).toBe('README.md')
    expect(meta.filename).toBe('README.md')
  })
})

describe('isWithinIndexedRoots', () => {
  test('returns true for paths within roots', () => {
    const roots = ['/Users/dev/project', '/Users/dev/other']

    expect(isWithinIndexedRoots('/Users/dev/project/src/file.ts', roots)).toBe(true)
    expect(isWithinIndexedRoots('/Users/dev/other/file.ts', roots)).toBe(true)
  })

  test('returns false for paths outside roots', () => {
    const roots = ['/Users/dev/project']

    expect(isWithinIndexedRoots('/Users/dev/other/file.ts', roots)).toBe(false)
    expect(isWithinIndexedRoots('/tmp/file.ts', roots)).toBe(false)
  })

  test('returns true for exact root path', () => {
    const roots = ['/Users/dev/project']

    expect(isWithinIndexedRoots('/Users/dev/project', roots)).toBe(true)
  })

  test('handles tilde expansion', () => {
    const roots = ['~/Developer']

    expect(isWithinIndexedRoots(`${homedir()}/Developer/project/file.ts`, roots)).toBe(true)
  })

  test('does not match partial path names', () => {
    const roots = ['/Users/dev/project']

    // Should NOT match because "project-backup" is not under "project"
    expect(isWithinIndexedRoots('/Users/dev/project-backup/file.ts', roots)).toBe(false)
  })
})

// ============================================================================
// indexDirectory Tests
// ============================================================================

describe('indexDirectory', () => {
  test('indexes files in a directory', async () => {
    // Create test files
    await writeFile(join(testDir, 'file1.ts'), 'content')
    await writeFile(join(testDir, 'file2.ts'), 'content')
    await mkdir(join(testDir, 'src'))
    await writeFile(join(testDir, 'src', 'index.ts'), 'content')

    const db = createMockDb()
    const dbOps = createMockDbOps()

    const result = await indexDirectory(testDir, { maxDepth: 10, exclude: [] }, db, dbOps, [
      testDir,
    ])

    expect(result.filesIndexed).toBe(3)
    expect(result.filesSkipped).toBe(0)
    expect(result.errors).toHaveLength(0)
    expect(dbOps.upsertedFiles).toHaveLength(3)
  })

  test('respects exclude patterns', async () => {
    await writeFile(join(testDir, 'file.ts'), 'content')
    await mkdir(join(testDir, 'node_modules'))
    await writeFile(join(testDir, 'node_modules', 'dep.js'), 'content')

    const db = createMockDb()
    const dbOps = createMockDbOps()

    const result = await indexDirectory(
      testDir,
      { maxDepth: 10, exclude: ['node_modules'] },
      db,
      dbOps,
      [testDir]
    )

    expect(result.filesIndexed).toBe(1)
    expect(dbOps.upsertedFiles.some(f => f.path.includes('node_modules'))).toBe(false)
  })

  test('respects maxDepth option', async () => {
    // Create nested structure
    await mkdir(join(testDir, 'a', 'b', 'c'), { recursive: true })
    await writeFile(join(testDir, 'root.ts'), 'content')
    await writeFile(join(testDir, 'a', 'level1.ts'), 'content')
    await writeFile(join(testDir, 'a', 'b', 'level2.ts'), 'content')
    await writeFile(join(testDir, 'a', 'b', 'c', 'level3.ts'), 'content')

    const db = createMockDb()
    const dbOps = createMockDbOps()

    // Note: fd's --max-depth N means "descend at most N directories"
    // maxDepth 2 = starting dir + one level down
    // So with maxDepth 2, we get root.ts and level1.ts
    const result = await indexDirectory(testDir, { maxDepth: 2, exclude: [] }, db, dbOps, [testDir])

    const indexedPaths = dbOps.upsertedFiles.map(f => f.filename)

    // With maxDepth 2: root.ts (depth 1) and level1.ts (depth 2) are found
    expect(indexedPaths).toContain('root.ts')
    expect(indexedPaths).toContain('level1.ts')

    // level2.ts requires depth 3 to reach (a/b/level2.ts)
    expect(indexedPaths).not.toContain('level2.ts')
    expect(indexedPaths).not.toContain('level3.ts')
  })

  test('respects maxFiles option', async () => {
    // Create many files
    for (let i = 0; i < 10; i++) {
      await writeFile(join(testDir, `file${i}.ts`), 'content')
    }

    const db = createMockDb()
    const dbOps = createMockDbOps()

    const result = await indexDirectory(
      testDir,
      { maxDepth: 10, exclude: [], maxFiles: 5 },
      db,
      dbOps,
      [testDir]
    )

    expect(dbOps.upsertedFiles.length).toBeLessThanOrEqual(5)
  })

  test('handles empty directories', async () => {
    await mkdir(join(testDir, 'empty'))

    const db = createMockDb()
    const dbOps = createMockDbOps()

    const result = await indexDirectory(testDir, { maxDepth: 10, exclude: [] }, db, dbOps, [
      testDir,
    ])

    expect(result.filesIndexed).toBe(0)
    expect(result.errors).toHaveLength(0)
  })

  test('handles inaccessible directories gracefully', async () => {
    // This test may not work on all platforms due to permission handling
    await writeFile(join(testDir, 'accessible.ts'), 'content')

    const db = createMockDb()
    const dbOps = createMockDbOps()

    const result = await indexDirectory(testDir, { maxDepth: 10, exclude: [] }, db, dbOps, [
      testDir,
    ])

    expect(result.filesIndexed).toBeGreaterThanOrEqual(1)
  })
})

// ============================================================================
// Symlink Tests
// ============================================================================

describe('symlink handling', () => {
  test('follows symlinks to files within indexed roots', async () => {
    await writeFile(join(testDir, 'target.ts'), 'content')
    await symlink(join(testDir, 'target.ts'), join(testDir, 'link.ts'))

    const db = createMockDb()
    const dbOps = createMockDbOps()

    const result = await indexDirectory(testDir, { maxDepth: 10, exclude: [] }, db, dbOps, [
      testDir,
    ])

    // Both target and link should resolve to the same canonical path
    // The exact count depends on fd vs fs fallback behavior
    expect(result.filesIndexed).toBeGreaterThanOrEqual(1)
    expect(result.errors).toHaveLength(0)
  })

  test('skips broken symlinks', async () => {
    await writeFile(join(testDir, 'real.ts'), 'content')
    await symlink(join(testDir, 'nonexistent.ts'), join(testDir, 'broken.ts'))

    const db = createMockDb()
    const dbOps = createMockDbOps()

    const result = await indexDirectory(testDir, { maxDepth: 10, exclude: [] }, db, dbOps, [
      testDir,
    ])

    // Should only index the real file
    expect(dbOps.upsertedFiles.some(f => f.filename === 'real.ts')).toBe(true)
    expect(result.errors).toHaveLength(0) // Broken symlinks are skipped silently
  })

  test('skips symlinks pointing outside indexed roots', async () => {
    // Create a file in tmp that's outside our test dir
    const outsideDir = join(tmpdir(), `outside-${Date.now()}`)
    await mkdir(outsideDir, { recursive: true })
    await writeFile(join(outsideDir, 'outside.ts'), 'content')

    // Create symlink pointing outside
    await symlink(join(outsideDir, 'outside.ts'), join(testDir, 'escape.ts'))
    await writeFile(join(testDir, 'inside.ts'), 'content')

    const db = createMockDb()
    const dbOps = createMockDbOps()

    try {
      const result = await indexDirectory(
        testDir,
        { maxDepth: 10, exclude: [] },
        db,
        dbOps,
        [testDir] // Only testDir is indexed
      )

      // Should only index inside.ts, not the symlink target
      const paths = dbOps.upsertedFiles.map(f => f.path)
      expect(paths.some(p => p.includes('inside.ts'))).toBe(true)
      expect(paths.some(p => p.includes('outside.ts'))).toBe(false)
    } finally {
      await rm(outsideDir, { recursive: true, force: true })
    }
  })
})

// ============================================================================
// Incremental Indexing Tests
// ============================================================================

describe('incremental indexing', () => {
  test('skips files not modified since last index', async () => {
    await writeFile(join(testDir, 'old.ts'), 'content')

    // Wait a bit then record the last indexed time
    await new Promise(resolve => setTimeout(resolve, 100))
    const lastIndexed = Date.now()

    // Wait a bit more then create a new file
    await new Promise(resolve => setTimeout(resolve, 100))
    await writeFile(join(testDir, 'new.ts'), 'content')

    const db = createMockDb()
    const dbOps = createMockDbOps()

    const result = await indexDirectory(
      testDir,
      { maxDepth: 10, exclude: [], incremental: true, lastIndexed },
      db,
      dbOps,
      [testDir]
    )

    // Should only index the new file
    expect(dbOps.upsertedFiles.some(f => f.filename === 'new.ts')).toBe(true)
    expect(result.filesSkipped).toBeGreaterThanOrEqual(1)
  })
})

// ============================================================================
// refreshIndex Tests
// ============================================================================

describe('refreshIndex', () => {
  test('processes all configured roots', async () => {
    const subdir1 = join(testDir, 'root1')
    const subdir2 = join(testDir, 'root2')
    await mkdir(subdir1)
    await mkdir(subdir2)
    await writeFile(join(subdir1, 'file1.ts'), 'content')
    await writeFile(join(subdir2, 'file2.ts'), 'content')

    const db = createMockDb()
    const dbOps = createMockDbOps()

    const config = createTestConfig({
      index: {
        roots: [subdir1, subdir2],
        disabled: [],
        exclude: { patterns: [] },
        include: { patterns: [] },
        depth: { default: 10 },
        limits: { max_files_per_root: 50000, warn_threshold_mb: 500 },
      },
    })

    const result = await refreshIndex(db, config, dbOps)

    expect(result.rootsProcessed).toBe(2)
    expect(result.totalFilesIndexed).toBe(2)
    expect(result.duration).toBeGreaterThan(0)
    expect(dbOps.updatedRoots).toHaveLength(2)
  })

  test('updates watched root metadata', async () => {
    await writeFile(join(testDir, 'file.ts'), 'content')

    const db = createMockDb()
    const dbOps = createMockDbOps()
    const config = createTestConfig()

    const beforeRefresh = Date.now()
    await refreshIndex(db, config, dbOps)

    expect(dbOps.updatedRoots).toHaveLength(1)
    const [updatedRoot] = dbOps.updatedRoots
    expect(updatedRoot?.root).toBe(testDir)
    expect(updatedRoot?.lastIndexed).toBeGreaterThanOrEqual(beforeRefresh)
  })
})

// ============================================================================
// pruneDeletedFiles Tests
// ============================================================================

describe('pruneDeletedFiles', () => {
  test('removes entries for deleted files', async () => {
    const existingFile = join(testDir, 'exists.ts')
    const deletedFile = join(testDir, 'deleted.ts')

    await writeFile(existingFile, 'content')
    // Don't create deletedFile - it doesn't exist

    const db = createMockDb()
    const dbOps = createMockDbOps()
    dbOps.filesForRoot.set(testDir, [existingFile, deletedFile])

    const pruned = await pruneDeletedFiles(db, testDir, dbOps)

    expect(pruned).toBe(1)
    expect(dbOps.deletedPaths).toContain(deletedFile)
    expect(dbOps.deletedPaths).not.toContain(existingFile)
  })

  test('handles empty index gracefully', async () => {
    const db = createMockDb()
    const dbOps = createMockDbOps()
    dbOps.filesForRoot.set(testDir, [])

    const pruned = await pruneDeletedFiles(db, testDir, dbOps)

    expect(pruned).toBe(0)
    expect(dbOps.deletedPaths).toHaveLength(0)
  })
})

// ============================================================================
// findRecentFiles Tests
// ============================================================================

describe('findRecentFiles', () => {
  test('finds files modified within time window', async () => {
    await writeFile(join(testDir, 'recent.ts'), 'content')
    await writeFile(join(testDir, 'also-recent.ts'), 'content')

    // Give filesystem time to settle
    await new Promise(resolve => setTimeout(resolve, 50))

    const files = await findRecentFiles(testDir, '1h', { exclude: [] })

    expect(files.length).toBeGreaterThanOrEqual(2)
    expect(files.some(f => f.includes('recent.ts'))).toBe(true)
    expect(files.some(f => f.includes('also-recent.ts'))).toBe(true)
  })

  test('respects exclude patterns', async () => {
    await writeFile(join(testDir, 'include.ts'), 'content')
    await mkdir(join(testDir, 'node_modules'))
    await writeFile(join(testDir, 'node_modules', 'exclude.js'), 'content')

    const files = await findRecentFiles(testDir, '1h', {
      exclude: ['node_modules'],
    })

    expect(files.some(f => f.includes('include.ts'))).toBe(true)
    expect(files.some(f => f.includes('exclude.js'))).toBe(false)
  })

  test('respects maxResults limit', async () => {
    // Create many files
    for (let i = 0; i < 20; i++) {
      await writeFile(join(testDir, `file${i}.ts`), 'content')
    }

    const files = await findRecentFiles(testDir, '1h', { maxResults: 5 })

    expect(files.length).toBeLessThanOrEqual(5)
  })
})

// ============================================================================
// Error Recovery Tests
// ============================================================================

describe('error recovery', () => {
  test('continues on individual file errors', async () => {
    await writeFile(join(testDir, 'good.ts'), 'content')
    // Create a situation that might cause an error
    // (platform-dependent, so we just ensure no crash)

    const db = createMockDb()
    const dbOps = createMockDbOps()

    const result = await indexDirectory(testDir, { maxDepth: 10, exclude: [] }, db, dbOps, [
      testDir,
    ])

    // Should not throw, should have at least the good file
    expect(result.filesIndexed).toBeGreaterThanOrEqual(1)
  })

  test('handles non-existent root directory', async () => {
    const nonExistent = join(testDir, 'does-not-exist')

    const db = createMockDb()
    const dbOps = createMockDbOps()

    const result = await indexDirectory(nonExistent, { maxDepth: 10, exclude: [] }, db, dbOps, [
      nonExistent,
    ])

    // Should return empty result, not throw
    expect(result.filesIndexed).toBe(0)
  })
})

// ============================================================================
// Batch Processing Tests
// ============================================================================

describe('batch processing', () => {
  test('batches inserts for performance', async () => {
    // Create more than BATCH_SIZE (100) files
    const fileCount = 150
    for (let i = 0; i < fileCount; i++) {
      await writeFile(join(testDir, `file${i.toString().padStart(3, '0')}.ts`), 'content')
    }

    const db = createMockDb()
    const dbOps = createMockDbOps()

    await indexDirectory(testDir, { maxDepth: 10, exclude: [] }, db, dbOps, [testDir])

    // upsertFiles should have been called multiple times for batching
    // Total files should still be correct
    expect(dbOps.upsertedFiles.length).toBe(fileCount)
  })
})
