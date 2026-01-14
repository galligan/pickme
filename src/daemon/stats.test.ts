/**
 * Tests for rolling window cache statistics.
 *
 * @module daemon/stats.test
 */

import { describe, expect, test } from 'bun:test'
import {
  createStatsState,
  getCacheHitRate,
  getTotalQueries,
  recordCacheHit,
  recordCacheMiss,
  resetStats,
} from './stats'

// ============================================================================
// createStatsState Tests
// ============================================================================

describe('createStatsState', () => {
  test('returns empty state', () => {
    const state = createStatsState()

    expect(state.hits).toBe(0)
    expect(state.misses).toBe(0)
    expect(state.ringCount).toBe(0)
    expect(state.ringIndex).toBe(0)
    expect(state.windowHits).toBe(0)
  })
})

// ============================================================================
// recordCacheHit Tests
// ============================================================================

describe('recordCacheHit', () => {
  test('increments hits counter', () => {
    const state = createStatsState()

    recordCacheHit(state)

    expect(state.hits).toBe(1)
  })

  test('adds to ring buffer', () => {
    const state = createStatsState()

    recordCacheHit(state)

    expect(state.ringCount).toBe(1)
    expect(state.windowHits).toBe(1)
  })

  test('can be called multiple times', () => {
    const state = createStatsState()

    recordCacheHit(state)
    recordCacheHit(state)
    recordCacheHit(state)

    expect(state.hits).toBe(3)
    expect(state.ringCount).toBe(3)
    expect(state.windowHits).toBe(3)
  })
})

// ============================================================================
// recordCacheMiss Tests
// ============================================================================

describe('recordCacheMiss', () => {
  test('increments misses counter', () => {
    const state = createStatsState()

    recordCacheMiss(state)

    expect(state.misses).toBe(1)
  })

  test('adds to ring buffer', () => {
    const state = createStatsState()

    recordCacheMiss(state)

    expect(state.ringCount).toBe(1)
    expect(state.windowHits).toBe(0)
  })

  test('can be called multiple times', () => {
    const state = createStatsState()

    recordCacheMiss(state)
    recordCacheMiss(state)
    recordCacheMiss(state)

    expect(state.misses).toBe(3)
    expect(state.ringCount).toBe(3)
    expect(state.windowHits).toBe(0)
  })
})

// ============================================================================
// getCacheHitRate Tests
// ============================================================================

describe('getCacheHitRate', () => {
  test('returns 0 for empty recentQueries', () => {
    const state = createStatsState()

    expect(getCacheHitRate(state)).toBe(0)
  })

  test('returns 1 for all hits', () => {
    const state = createStatsState()

    recordCacheHit(state)
    recordCacheHit(state)
    recordCacheHit(state)

    expect(getCacheHitRate(state)).toBe(1)
  })

  test('returns 0 for all misses', () => {
    const state = createStatsState()

    recordCacheMiss(state)
    recordCacheMiss(state)
    recordCacheMiss(state)

    expect(getCacheHitRate(state)).toBe(0)
  })

  test('returns correct ratio for mixed hits and misses', () => {
    const state = createStatsState()

    recordCacheHit(state)
    recordCacheHit(state)
    recordCacheMiss(state)
    recordCacheMiss(state)

    expect(getCacheHitRate(state)).toBe(0.5)
  })

  test('returns correct ratio for 3/4 hit rate', () => {
    const state = createStatsState()

    recordCacheHit(state)
    recordCacheHit(state)
    recordCacheHit(state)
    recordCacheMiss(state)

    expect(getCacheHitRate(state)).toBe(0.75)
  })
})

// ============================================================================
// Rolling Window Tests
// ============================================================================

describe('rolling window', () => {
  test('maintains max 100 entries', () => {
    const state = createStatsState()

    // Add 150 entries
    for (let i = 0; i < 150; i++) {
      recordCacheHit(state)
    }

    expect(state.ringCount).toBe(100)
    expect(state.hits).toBe(150) // Total hits is still tracked
  })

  test('hit rate uses rolling window (old entries pushed out)', () => {
    const state = createStatsState()

    // Start with 100 misses
    for (let i = 0; i < 100; i++) {
      recordCacheMiss(state)
    }

    expect(getCacheHitRate(state)).toBe(0)

    // Add 100 hits - should push out all misses
    for (let i = 0; i < 100; i++) {
      recordCacheHit(state)
    }

    // Rolling window should now be all hits
    expect(getCacheHitRate(state)).toBe(1)
    expect(state.ringCount).toBe(100)
  })

  test('rolling window correctly tracks recent performance', () => {
    const state = createStatsState()

    // Add 50 hits
    for (let i = 0; i < 50; i++) {
      recordCacheHit(state)
    }

    // Add 50 misses
    for (let i = 0; i < 50; i++) {
      recordCacheMiss(state)
    }

    expect(getCacheHitRate(state)).toBe(0.5)

    // Add 50 more hits - should push out 50 of the original hits
    for (let i = 0; i < 50; i++) {
      recordCacheHit(state)
    }

    // Now window is: 50 misses + 50 hits = 50% hit rate
    expect(getCacheHitRate(state)).toBe(0.5)
    expect(state.ringCount).toBe(100)
  })
})

// ============================================================================
// getTotalQueries Tests
// ============================================================================

describe('getTotalQueries', () => {
  test('returns 0 for new state', () => {
    const state = createStatsState()

    expect(getTotalQueries(state)).toBe(0)
  })

  test('returns sum of hits and misses', () => {
    const state = createStatsState()

    recordCacheHit(state)
    recordCacheHit(state)
    recordCacheMiss(state)

    expect(getTotalQueries(state)).toBe(3)
  })

  test('counts all queries even beyond rolling window', () => {
    const state = createStatsState()

    for (let i = 0; i < 150; i++) {
      recordCacheHit(state)
    }
    for (let i = 0; i < 50; i++) {
      recordCacheMiss(state)
    }

    expect(getTotalQueries(state)).toBe(200)
  })
})

// ============================================================================
// resetStats Tests
// ============================================================================

describe('resetStats', () => {
  test('clears all state', () => {
    const state = createStatsState()

    recordCacheHit(state)
    recordCacheHit(state)
    recordCacheMiss(state)

    resetStats(state)

    expect(state.hits).toBe(0)
    expect(state.misses).toBe(0)
    expect(state.ringCount).toBe(0)
    expect(state.windowHits).toBe(0)
  })

  test('clears state with rolling window full', () => {
    const state = createStatsState()

    for (let i = 0; i < 150; i++) {
      recordCacheHit(state)
    }

    resetStats(state)

    expect(state.hits).toBe(0)
    expect(state.misses).toBe(0)
    expect(state.ringCount).toBe(0)
    expect(state.windowHits).toBe(0)
    expect(getCacheHitRate(state)).toBe(0)
  })
})
