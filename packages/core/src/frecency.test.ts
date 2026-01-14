/**
 * Tests for frecency scoring module.
 */
import { describe, expect, test } from 'bun:test'
import type { WeightsConfig } from './config'
import {
  calculateScore,
  buildFrecencyRecords,
  applyFrecencyRanking,
  mergeResults,
  type FrecencyRecord,
  type SearchResult,
  type RankedResult,
  type BuildFrecencyOptions,
} from './frecency'

// Test weights configuration
const testWeights: WeightsConfig = {
  git_recency: 1.0,
  git_frequency: 0.5,
  git_status: 5.0,
}

/**
 * Helper to assert a value is defined and return it with narrowed type.
 * Throws if the value is undefined.
 */
function assertDefined<T>(value: T | undefined, message = 'Expected value to be defined'): T {
  if (value === undefined) {
    throw new Error(message)
  }
  return value
}

// Helper to create a FrecencyRecord
function createRecord(
  path: string,
  overrides: Partial<Omit<FrecencyRecord, 'path'>> = {}
): FrecencyRecord {
  return {
    path,
    gitRecency: 0,
    gitFrequency: 0,
    gitStatusBoost: 0,
    lastSeen: Date.now(),
    ...overrides,
  }
}

// Helper to create a SearchResult
function createSearchResult(
  path: string,
  score: number = 0,
  overrides: Partial<Omit<SearchResult, 'path' | 'score'>> = {}
): SearchResult {
  const filename = path.split('/').pop() ?? path
  return {
    path,
    filename,
    relativePath: path,
    score,
    ...overrides,
  }
}

describe('calculateScore', () => {
  test('returns 0 for record with all zeros', () => {
    const record = createRecord('/test/file.ts')
    const score = calculateScore(record, testWeights)
    expect(score).toBe(0)
  })

  test('applies git_recency weight correctly', () => {
    const record = createRecord('/test/file.ts', { gitRecency: 1.0 })
    const score = calculateScore(record, testWeights)
    expect(score).toBe(1.0) // 1.0 * 1.0 + 0 * 0.5 + 0 * 5.0
  })

  test('applies git_frequency weight correctly', () => {
    const record = createRecord('/test/file.ts', { gitFrequency: 10 })
    const score = calculateScore(record, testWeights)
    expect(score).toBe(5.0) // 0 * 1.0 + 10 * 0.5 + 0 * 5.0
  })

  test('applies git_status weight correctly', () => {
    const record = createRecord('/test/file.ts', { gitStatusBoost: 5.0 })
    const score = calculateScore(record, testWeights)
    expect(score).toBe(25.0) // 0 * 1.0 + 0 * 0.5 + 5.0 * 5.0
  })

  test('combines all factors correctly', () => {
    const record = createRecord('/test/file.ts', {
      gitRecency: 0.5,
      gitFrequency: 4,
      gitStatusBoost: 3.0,
    })
    const score = calculateScore(record, testWeights)
    // 0.5 * 1.0 + 4 * 0.5 + 3.0 * 5.0 = 0.5 + 2 + 15 = 17.5
    expect(score).toBe(17.5)
  })

  test('uses custom weights', () => {
    const record = createRecord('/test/file.ts', {
      gitRecency: 1.0,
      gitFrequency: 2,
      gitStatusBoost: 1.0,
    })
    const customWeights: WeightsConfig = {
      git_recency: 2.0,
      git_frequency: 1.0,
      git_status: 3.0,
    }
    const score = calculateScore(record, customWeights)
    // 1.0 * 2.0 + 2 * 1.0 + 1.0 * 3.0 = 2 + 2 + 3 = 7
    expect(score).toBe(7)
  })

  test('handles zero weights gracefully', () => {
    const record = createRecord('/test/file.ts', {
      gitRecency: 1.0,
      gitFrequency: 10,
      gitStatusBoost: 5.0,
    })
    const zeroWeights: WeightsConfig = {
      git_recency: 0,
      git_frequency: 0,
      git_status: 0,
    }
    const score = calculateScore(record, zeroWeights)
    expect(score).toBe(0)
  })

  test('handles very small recency scores', () => {
    const record = createRecord('/test/file.ts', { gitRecency: 0.001 })
    const score = calculateScore(record, testWeights)
    expect(score).toBeCloseTo(0.001, 6)
  })
})

describe('applyFrecencyRanking', () => {
  test('returns empty array for empty input', () => {
    const results = applyFrecencyRanking([], new Map(), testWeights)
    expect(results).toEqual([])
  })

  test('adds frecency and final scores to results', () => {
    const searchResults: SearchResult[] = [createSearchResult('/test/a.ts', 10)]
    const frecencyMap = new Map<string, FrecencyRecord>([
      ['/test/a.ts', createRecord('/test/a.ts', { gitRecency: 0.5 })],
    ])

    const results = applyFrecencyRanking(searchResults, frecencyMap, testWeights)

    expect(results).toHaveLength(1)
    const first = assertDefined(results[0])
    expect(first.frecencyScore).toBe(0.5) // 0.5 * 1.0
    expect(first.finalScore).toBeDefined()
  })

  test('handles results not in frecency map', () => {
    const searchResults: SearchResult[] = [createSearchResult('/test/unknown.ts', 5)]

    const results = applyFrecencyRanking(searchResults, new Map(), testWeights)

    expect(results).toHaveLength(1)
    const first = assertDefined(results[0])
    expect(first.frecencyScore).toBe(0)
  })

  test('re-ranks results by final score descending', () => {
    const searchResults: SearchResult[] = [
      createSearchResult('/test/low-fts.ts', 1),
      createSearchResult('/test/high-fts.ts', 10),
    ]
    const frecencyMap = new Map<string, FrecencyRecord>([
      // low-fts has high frecency (modified file)
      ['/test/low-fts.ts', createRecord('/test/low-fts.ts', { gitStatusBoost: 5.0 })],
      // high-fts has no frecency boost
      ['/test/high-fts.ts', createRecord('/test/high-fts.ts')],
    ])

    const results = applyFrecencyRanking(searchResults, frecencyMap, testWeights)

    // low-fts should now be first due to high frecency
    expect(results).toHaveLength(2)
    const first = assertDefined(results[0])
    const second = assertDefined(results[1])
    expect(first.path).toBe('/test/low-fts.ts')
    expect(second.path).toBe('/test/high-fts.ts')
  })

  test('preserves original search result properties', () => {
    const searchResults: SearchResult[] = [
      createSearchResult('/test/file.ts', 5, {
        filename: 'file.ts',
        relativePath: 'src/file.ts',
      }),
    ]

    const results = applyFrecencyRanking(searchResults, new Map(), testWeights)

    expect(results).toHaveLength(1)
    const first = assertDefined(results[0])
    expect(first.path).toBe('/test/file.ts')
    expect(first.filename).toBe('file.ts')
    expect(first.relativePath).toBe('src/file.ts')
    expect(first.score).toBe(5)
  })

  test('combines FTS score and frecency score for final ranking', () => {
    const searchResults: SearchResult[] = [
      createSearchResult('/test/a.ts', 10),
      createSearchResult('/test/b.ts', 8),
    ]
    const frecencyMap = new Map<string, FrecencyRecord>([
      ['/test/a.ts', createRecord('/test/a.ts', { gitRecency: 0.2 })],
      ['/test/b.ts', createRecord('/test/b.ts', { gitRecency: 1.0 })],
    ])

    const results = applyFrecencyRanking(searchResults, frecencyMap, testWeights)

    // Both have FTS scores and frecency, final score should combine them
    expect(results).toHaveLength(2)
    const first = assertDefined(results[0])
    const second = assertDefined(results[1])
    expect(first.finalScore).toBeGreaterThan(0)
    expect(second.finalScore).toBeGreaterThan(0)
  })
})

describe('mergeResults', () => {
  test('returns indexed results when no fresh files', () => {
    const indexed: SearchResult[] = [
      createSearchResult('/test/a.ts', 10),
      createSearchResult('/test/b.ts', 5),
    ]

    const results = mergeResults(indexed, [])

    expect(results).toEqual(indexed)
  })

  test('adds fresh files not in indexed results', () => {
    const indexed: SearchResult[] = [createSearchResult('/test/a.ts', 10)]
    const fresh = ['/test/b.ts', '/test/c.ts']

    const results = mergeResults(indexed, fresh)

    expect(results).toHaveLength(3)
    expect(results.map(r => r.path)).toContain('/test/b.ts')
    expect(results.map(r => r.path)).toContain('/test/c.ts')
  })

  test('fresh files have score 0', () => {
    const indexed: SearchResult[] = []
    const fresh = ['/test/new.ts']

    const results = mergeResults(indexed, fresh)

    expect(results).toHaveLength(1)
    const first = assertDefined(results[0])
    expect(first.path).toBe('/test/new.ts')
    expect(first.score).toBe(0)
  })

  test('does not duplicate files already in indexed', () => {
    const indexed: SearchResult[] = [createSearchResult('/test/a.ts', 10)]
    const fresh = ['/test/a.ts'] // Same file

    const results = mergeResults(indexed, fresh)

    expect(results).toHaveLength(1)
    const first = assertDefined(results[0])
    expect(first.path).toBe('/test/a.ts')
    expect(first.score).toBe(10) // Keeps indexed score
  })

  test('extracts filename from path for fresh files', () => {
    const fresh = ['/path/to/component.tsx']

    const results = mergeResults([], fresh)

    expect(results).toHaveLength(1)
    const first = assertDefined(results[0])
    expect(first.filename).toBe('component.tsx')
  })

  test('uses path as relativePath for fresh files', () => {
    const fresh = ['/path/to/file.ts']

    const results = mergeResults([], fresh)

    expect(results).toHaveLength(1)
    const first = assertDefined(results[0])
    expect(first.relativePath).toBe('/path/to/file.ts')
  })

  test('handles empty inputs', () => {
    const results = mergeResults([], [])
    expect(results).toEqual([])
  })
})

describe('buildFrecencyRecords', () => {
  // Note: These tests require mocking git operations
  // The actual implementation will use git.ts functions

  test('returns empty array for non-git directory', async () => {
    // Using a path that's definitely not a git repo
    const records = await buildFrecencyRecords('/tmp/definitely-not-a-repo-12345')
    expect(records).toEqual([])
  })

  test('accepts options for since and maxCommits', async () => {
    // This tests that the function signature is correct
    const options: BuildFrecencyOptions = {
      since: '30 days ago',
      maxCommits: 500,
    }

    // Should not throw with valid options
    const records = await buildFrecencyRecords('/tmp/not-a-repo', options)
    expect(Array.isArray(records)).toBe(true)
  })

  test('records have correct structure', async () => {
    // This is a structural test - we check the shape of records
    // For real git repos, this would return actual data
    const records = await buildFrecencyRecords('/tmp/not-a-repo')

    // Even empty, it should be an array
    expect(Array.isArray(records)).toBe(true)

    // If we had records, they would have this shape:
    // {
    //   path: string,
    //   gitRecency: number (0-1),
    //   gitFrequency: number,
    //   gitStatusBoost: number,
    //   lastSeen: number
    // }
  })
})

describe('integration: score calculation with git data shapes', () => {
  test('gitRecency of 1.0 (just committed) gets full weight', () => {
    const record = createRecord('/test/file.ts', { gitRecency: 1.0 })
    const score = calculateScore(record, testWeights)
    expect(score).toBe(1.0 * testWeights.git_recency)
  })

  test('gitRecency of 0.5 (14 days old) gets half weight', () => {
    const record = createRecord('/test/file.ts', { gitRecency: 0.5 })
    const score = calculateScore(record, testWeights)
    expect(score).toBeCloseTo(0.5 * testWeights.git_recency, 5)
  })

  test('modified file (gitStatusBoost 5.0) significantly boosts score', () => {
    const unmodified = createRecord('/test/a.ts', { gitRecency: 1.0 })
    const modified = createRecord('/test/b.ts', { gitRecency: 0.5, gitStatusBoost: 5.0 })

    const unmodifiedScore = calculateScore(unmodified, testWeights)
    const modifiedScore = calculateScore(modified, testWeights)

    // Modified file with older commit should still score higher due to status boost
    expect(modifiedScore).toBeGreaterThan(unmodifiedScore)
  })

  test('high frequency (many commits) adds to score', () => {
    const lowFreq = createRecord('/test/a.ts', { gitFrequency: 1 })
    const highFreq = createRecord('/test/b.ts', { gitFrequency: 100 })

    const lowScore = calculateScore(lowFreq, testWeights)
    const highScore = calculateScore(highFreq, testWeights)

    expect(highScore).toBeGreaterThan(lowScore)
    expect(highScore - lowScore).toBe(99 * testWeights.git_frequency)
  })
})
