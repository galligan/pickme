/**
 * Tests for git utilities.
 *
 * Tests git repository detection, status parsing, and recency scoring.
 *
 * @module git.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { $ } from 'bun'
import {
  isGitRepo,
  getGitStatusBoosts,
  getGitRecency,
  gitRecencyScore,
  type GitRecencyData,
} from './git'

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a temporary git repository for testing.
 */
async function createTempGitRepo(): Promise<{
  root: string
  cleanup: () => void
}> {
  const tempDir = mkdtempSync(join(tmpdir(), 'file-picker-git-test-'))

  // Initialize git repo
  await $`git -C ${tempDir} init`.quiet()
  await $`git -C ${tempDir} config user.email "test@example.com"`.quiet()
  await $`git -C ${tempDir} config user.name "Test User"`.quiet()

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
 * Creates a temporary non-git directory for testing.
 */
function createTempDir(): { root: string; cleanup: () => void } {
  const tempDir = mkdtempSync(join(tmpdir(), 'file-picker-nogit-test-'))

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

// ============================================================================
// isGitRepo Tests
// ============================================================================

describe('isGitRepo', () => {
  test('returns true for git repository', async () => {
    const { root, cleanup } = await createTempGitRepo()

    try {
      const result = await isGitRepo(root)
      expect(result).toBe(true)
    } finally {
      cleanup()
    }
  })

  test('returns true for subdirectory of git repository', async () => {
    const { root, cleanup } = await createTempGitRepo()
    const subdir = join(root, 'src', 'components')
    mkdirSync(subdir, { recursive: true })

    try {
      const result = await isGitRepo(subdir)
      expect(result).toBe(true)
    } finally {
      cleanup()
    }
  })

  test('returns false for non-git directory', async () => {
    const { root, cleanup } = createTempDir()

    try {
      const result = await isGitRepo(root)
      expect(result).toBe(false)
    } finally {
      cleanup()
    }
  })

  test('returns false for non-existent directory', async () => {
    const result = await isGitRepo('/nonexistent/path/that/does/not/exist')
    expect(result).toBe(false)
  })
})

// ============================================================================
// getGitStatusBoosts Tests
// ============================================================================

describe('getGitStatusBoosts', () => {
  test('returns empty map for clean repository', async () => {
    const { root, cleanup } = await createTempGitRepo()

    // Create a file and commit it
    writeFileSync(join(root, 'file.txt'), 'content')
    await $`git -C ${root} add file.txt`.quiet()
    await $`git -C ${root} commit -m "Initial commit"`.quiet()

    try {
      const boosts = await getGitStatusBoosts(root)
      expect(boosts.size).toBe(0)
    } finally {
      cleanup()
    }
  })

  test('returns boost for modified file', async () => {
    const { root, cleanup } = await createTempGitRepo()

    // Create and commit a file
    writeFileSync(join(root, 'file.txt'), 'content')
    await $`git -C ${root} add file.txt`.quiet()
    await $`git -C ${root} commit -m "Initial commit"`.quiet()

    // Modify the file
    writeFileSync(join(root, 'file.txt'), 'modified content')

    try {
      const boosts = await getGitStatusBoosts(root)
      const filePath = join(root, 'file.txt')
      expect(boosts.has(filePath)).toBe(true)
      expect(boosts.get(filePath)).toBe(5.0) // Modified files get 5.0
    } finally {
      cleanup()
    }
  })

  test('returns boost for staged file', async () => {
    const { root, cleanup } = await createTempGitRepo()

    // Create and commit a file
    writeFileSync(join(root, 'file.txt'), 'content')
    await $`git -C ${root} add file.txt`.quiet()
    await $`git -C ${root} commit -m "Initial commit"`.quiet()

    // Modify and stage
    writeFileSync(join(root, 'file.txt'), 'modified content')
    await $`git -C ${root} add file.txt`.quiet()

    try {
      const boosts = await getGitStatusBoosts(root)
      const filePath = join(root, 'file.txt')
      expect(boosts.has(filePath)).toBe(true)
      expect(boosts.get(filePath)).toBe(5.0)
    } finally {
      cleanup()
    }
  })

  test('returns lower boost for untracked file', async () => {
    const { root, cleanup } = await createTempGitRepo()

    // Create an initial commit so we have a valid repo
    writeFileSync(join(root, 'initial.txt'), 'initial')
    await $`git -C ${root} add initial.txt`.quiet()
    await $`git -C ${root} commit -m "Initial commit"`.quiet()

    // Create an untracked file
    writeFileSync(join(root, 'untracked.txt'), 'untracked content')

    try {
      const boosts = await getGitStatusBoosts(root)
      const filePath = join(root, 'untracked.txt')
      expect(boosts.has(filePath)).toBe(true)
      expect(boosts.get(filePath)).toBe(3.0) // Untracked files get 3.0
    } finally {
      cleanup()
    }
  })

  test('returns empty map for non-git directory', async () => {
    const { root, cleanup } = createTempDir()

    try {
      const boosts = await getGitStatusBoosts(root)
      expect(boosts.size).toBe(0)
    } finally {
      cleanup()
    }
  })

  test('handles multiple modified files', async () => {
    const { root, cleanup } = await createTempGitRepo()

    // Create and commit files
    writeFileSync(join(root, 'file1.txt'), 'content1')
    writeFileSync(join(root, 'file2.txt'), 'content2')
    await $`git -C ${root} add .`.quiet()
    await $`git -C ${root} commit -m "Initial commit"`.quiet()

    // Modify both files
    writeFileSync(join(root, 'file1.txt'), 'modified1')
    writeFileSync(join(root, 'file2.txt'), 'modified2')

    try {
      const boosts = await getGitStatusBoosts(root)
      expect(boosts.size).toBe(2)
      expect(boosts.get(join(root, 'file1.txt'))).toBe(5.0)
      expect(boosts.get(join(root, 'file2.txt'))).toBe(5.0)
    } finally {
      cleanup()
    }
  })

  test('handles files with spaces in names', async () => {
    const { root, cleanup } = await createTempGitRepo()

    // Create and commit a file with spaces
    const fileName = 'file with spaces.txt'
    writeFileSync(join(root, fileName), 'content')
    await $`git -C ${root} add ${fileName}`.quiet()
    await $`git -C ${root} commit -m "Initial commit"`.quiet()

    // Modify the file
    writeFileSync(join(root, fileName), 'modified')

    try {
      const boosts = await getGitStatusBoosts(root)
      const filePath = join(root, fileName)
      expect(boosts.has(filePath)).toBe(true)
    } finally {
      cleanup()
    }
  })
})

// ============================================================================
// getGitRecency Tests
// ============================================================================

describe('getGitRecency', () => {
  test('returns empty map for empty repository', async () => {
    const { root, cleanup } = await createTempGitRepo()

    try {
      const recency = await getGitRecency(root)
      expect(recency.size).toBe(0)
    } finally {
      cleanup()
    }
  })

  test('returns recency data for committed files', async () => {
    const { root, cleanup } = await createTempGitRepo()

    // Create and commit a file
    writeFileSync(join(root, 'file.txt'), 'content')
    await $`git -C ${root} add file.txt`.quiet()
    await $`git -C ${root} commit -m "Initial commit"`.quiet()

    try {
      const recency = await getGitRecency(root)
      const filePath = join(root, 'file.txt')
      expect(recency.has(filePath)).toBe(true)

      const data = recency.get(filePath)!
      expect(data.frequency).toBe(1)
      expect(data.lastCommit).toBeGreaterThan(0)
    } finally {
      cleanup()
    }
  })

  test('tracks commit frequency', async () => {
    const { root, cleanup } = await createTempGitRepo()

    // Create a file
    writeFileSync(join(root, 'file.txt'), 'content1')
    await $`git -C ${root} add file.txt`.quiet()
    await $`git -C ${root} commit -m "Commit 1"`.quiet()

    // Modify and commit again
    writeFileSync(join(root, 'file.txt'), 'content2')
    await $`git -C ${root} add file.txt`.quiet()
    await $`git -C ${root} commit -m "Commit 2"`.quiet()

    // Modify and commit a third time
    writeFileSync(join(root, 'file.txt'), 'content3')
    await $`git -C ${root} add file.txt`.quiet()
    await $`git -C ${root} commit -m "Commit 3"`.quiet()

    try {
      const recency = await getGitRecency(root)
      const filePath = join(root, 'file.txt')
      const data = recency.get(filePath)!

      expect(data.frequency).toBe(3)
    } finally {
      cleanup()
    }
  })

  test('returns empty map for non-git directory', async () => {
    const { root, cleanup } = createTempDir()

    try {
      const recency = await getGitRecency(root)
      expect(recency.size).toBe(0)
    } finally {
      cleanup()
    }
  })

  test('respects since option', async () => {
    const { root, cleanup } = await createTempGitRepo()

    // Create and commit a file
    writeFileSync(join(root, 'file.txt'), 'content')
    await $`git -C ${root} add file.txt`.quiet()
    await $`git -C ${root} commit -m "Initial commit"`.quiet()

    try {
      // With a very short since, should still find recent commits
      const recency = await getGitRecency(root, { since: '1 day ago' })
      const filePath = join(root, 'file.txt')
      expect(recency.has(filePath)).toBe(true)
    } finally {
      cleanup()
    }
  })

  test('respects maxCommits option', async () => {
    const { root, cleanup } = await createTempGitRepo()

    // Create multiple commits
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(root, 'file.txt'), `content${i}`)
      await $`git -C ${root} add file.txt`.quiet()
      await $`git -C ${root} commit -m "Commit ${i}"`.quiet()
    }

    try {
      const recency = await getGitRecency(root, { maxCommits: 3 })
      const filePath = join(root, 'file.txt')
      const data = recency.get(filePath)

      // Should have at most 3 commits counted
      expect(data?.frequency).toBeLessThanOrEqual(3)
    } finally {
      cleanup()
    }
  })

  test('handles multiple files', async () => {
    const { root, cleanup } = await createTempGitRepo()

    // Create and commit multiple files
    writeFileSync(join(root, 'file1.txt'), 'content1')
    writeFileSync(join(root, 'file2.txt'), 'content2')
    await $`git -C ${root} add .`.quiet()
    await $`git -C ${root} commit -m "Initial commit"`.quiet()

    try {
      const recency = await getGitRecency(root)
      expect(recency.has(join(root, 'file1.txt'))).toBe(true)
      expect(recency.has(join(root, 'file2.txt'))).toBe(true)
    } finally {
      cleanup()
    }
  })
})

// ============================================================================
// gitRecencyScore Tests
// ============================================================================

describe('gitRecencyScore', () => {
  test('returns ~1.0 for recent commit', () => {
    const now = Math.floor(Date.now() / 1000)
    const score = gitRecencyScore(now)
    expect(score).toBeCloseTo(1.0, 1)
  })

  test('returns ~0.368 for 14-day-old commit (one half-life)', () => {
    const now = Math.floor(Date.now() / 1000)
    const fourteenDaysAgo = now - 14 * 24 * 60 * 60
    const score = gitRecencyScore(fourteenDaysAgo)
    // e^-1 = 0.368
    expect(score).toBeCloseTo(0.368, 1)
  })

  test('returns ~0.135 for 28-day-old commit (two half-lives)', () => {
    const now = Math.floor(Date.now() / 1000)
    const twentyEightDaysAgo = now - 28 * 24 * 60 * 60
    const score = gitRecencyScore(twentyEightDaysAgo)
    // e^-2 = 0.135
    expect(score).toBeCloseTo(0.135, 1)
  })

  test('returns small value for very old commit', () => {
    const now = Math.floor(Date.now() / 1000)
    const ninetyDaysAgo = now - 90 * 24 * 60 * 60
    const score = gitRecencyScore(ninetyDaysAgo)
    expect(score).toBeLessThan(0.01)
  })

  test('returns positive value for all reasonable timestamps', () => {
    const now = Math.floor(Date.now() / 1000)

    // Test various ages
    const ages = [0, 1, 7, 14, 30, 60, 90, 180, 365]
    for (const days of ages) {
      const timestamp = now - days * 24 * 60 * 60
      const score = gitRecencyScore(timestamp)
      expect(score).toBeGreaterThan(0)
      expect(score).toBeLessThanOrEqual(1)
    }
  })

  test('scores decrease monotonically with age', () => {
    const now = Math.floor(Date.now() / 1000)

    let previousScore = 1.0
    const ages = [1, 7, 14, 30, 60, 90]
    for (const days of ages) {
      const timestamp = now - days * 24 * 60 * 60
      const score = gitRecencyScore(timestamp)
      expect(score).toBeLessThan(previousScore)
      previousScore = score
    }
  })
})
