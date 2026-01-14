/**
 * Tests for daemon caching utilities.
 *
 * @module daemon/cache.test
 */

import { describe, expect, test, beforeEach } from 'bun:test'
import { TTLCache, PrefixCache } from './cache'
import type { DaemonSearchResult } from './protocol'

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates mock search results for testing.
 */
function createMockResults(count: number, prefix = 'file'): DaemonSearchResult[] {
  return Array.from({ length: count }, (_, i) => ({
    path: `/root/${prefix}${i}.ts`,
    score: 1.0 - i * 0.1,
    root: '/root',
  }))
}

// ============================================================================
// TTLCache Tests
// ============================================================================

describe('TTLCache', () => {
  describe('makeKey', () => {
    test('generates consistent keys', () => {
      const key1 = TTLCache.makeKey(1, '/root', 'button', 50)
      const key2 = TTLCache.makeKey(1, '/root', 'button', 50)
      expect(key1).toBe(key2)
    })

    test('generates different keys for different parameters', () => {
      const key1 = TTLCache.makeKey(1, '/root', 'button', 50)
      const key2 = TTLCache.makeKey(2, '/root', 'button', 50)
      const key3 = TTLCache.makeKey(1, '/other', 'button', 50)
      const key4 = TTLCache.makeKey(1, '/root', 'modal', 50)
      const key5 = TTLCache.makeKey(1, '/root', 'button', 100)

      expect(key1).not.toBe(key2)
      expect(key1).not.toBe(key3)
      expect(key1).not.toBe(key4)
      expect(key1).not.toBe(key5)
    })
  })

  describe('get/set', () => {
    let cache: TTLCache

    beforeEach(() => {
      cache = new TTLCache({ ttlMs: 1000, maxEntries: 100 })
    })

    test('missing key returns undefined', () => {
      const result = cache.get('nonexistent')
      expect(result).toBeUndefined()
    })

    test('stores and retrieves results', () => {
      const results = createMockResults(3)
      const key = 'test-key'

      cache.set(key, results)
      const retrieved = cache.get(key)

      expect(retrieved).toBeDefined()
      expect(retrieved).toEqual(results)
    })

    test('expires entries after TTL', async () => {
      const cache = new TTLCache({ ttlMs: 100, maxEntries: 100 })
      const results = createMockResults(2)
      const key = 'test-key'

      cache.set(key, results)
      expect(cache.get(key)).toBeDefined()

      // Wait for TTL to expire
      await Bun.sleep(150)

      expect(cache.get(key)).toBeUndefined()
    })

    test('evicts oldest when max reached', () => {
      const cache = new TTLCache({ ttlMs: 10000, maxEntries: 3 })

      // Add 3 entries
      cache.set('key1', createMockResults(1, 'a'))
      cache.set('key2', createMockResults(1, 'b'))
      cache.set('key3', createMockResults(1, 'c'))

      // All should be present
      expect(cache.get('key1')).toBeDefined()
      expect(cache.get('key2')).toBeDefined()
      expect(cache.get('key3')).toBeDefined()
      expect(cache.size).toBe(3)

      // Add 4th entry - should evict oldest (key1)
      cache.set('key4', createMockResults(1, 'd'))

      expect(cache.get('key1')).toBeUndefined()
      expect(cache.get('key2')).toBeDefined()
      expect(cache.get('key3')).toBeDefined()
      expect(cache.get('key4')).toBeDefined()
      expect(cache.size).toBe(3)
    })
  })

  describe('clear', () => {
    test('removes all entries', () => {
      const cache = new TTLCache({ ttlMs: 10000, maxEntries: 100 })

      cache.set('key1', createMockResults(1))
      cache.set('key2', createMockResults(1))
      cache.set('key3', createMockResults(1))

      expect(cache.size).toBe(3)

      cache.clear()

      expect(cache.size).toBe(0)
      expect(cache.get('key1')).toBeUndefined()
      expect(cache.get('key2')).toBeUndefined()
      expect(cache.get('key3')).toBeUndefined()
    })
  })

  describe('prune', () => {
    test('removes expired entries and returns count', async () => {
      const cache = new TTLCache({ ttlMs: 100, maxEntries: 100 })

      cache.set('key1', createMockResults(1))
      cache.set('key2', createMockResults(1))

      // Wait for expiration
      await Bun.sleep(150)

      // Add fresh entry
      cache.set('key3', createMockResults(1))

      expect(cache.size).toBe(3)

      const pruned = cache.prune()

      expect(pruned).toBe(2) // key1 and key2 should be pruned
      expect(cache.size).toBe(1)
      expect(cache.get('key3')).toBeDefined()
    })

    test('returns 0 when nothing to prune', () => {
      const cache = new TTLCache({ ttlMs: 10000, maxEntries: 100 })

      cache.set('key1', createMockResults(1))

      const pruned = cache.prune()

      expect(pruned).toBe(0)
      expect(cache.size).toBe(1)
    })
  })

  describe('size', () => {
    test('returns correct count', () => {
      const cache = new TTLCache({ ttlMs: 10000, maxEntries: 100 })

      expect(cache.size).toBe(0)

      cache.set('key1', createMockResults(1))
      expect(cache.size).toBe(1)

      cache.set('key2', createMockResults(1))
      expect(cache.size).toBe(2)

      cache.clear()
      expect(cache.size).toBe(0)
    })
  })
})

// ============================================================================
// PrefixCache Tests
// ============================================================================

describe('PrefixCache', () => {
  let cache: PrefixCache

  beforeEach(() => {
    cache = new PrefixCache({ ttlMs: 1000 })
  })

  describe('tryFilter', () => {
    test('returns undefined when empty', () => {
      const result = cache.tryFilter('button', '/root', r => r.path.includes('button'))
      expect(result).toBeUndefined()
    })

    test('returns undefined for non-extension query', () => {
      const results = createMockResults(5, 'button')
      cache.store('button', '/root', results)

      // "modal" does not extend "button"
      const result = cache.tryFilter('modal', '/root', r => r.path.includes('modal'))
      expect(result).toBeUndefined()
    })

    test('returns undefined for different cwd', () => {
      const results = createMockResults(5, 'button')
      cache.store('button', '/root', results)

      // Different cwd
      const result = cache.tryFilter('buttoni', '/other', r => r.path.includes('buttoni'))
      expect(result).toBeUndefined()
    })

    test('filters results for extended query', () => {
      // Store results for "but"
      const results: DaemonSearchResult[] = [
        { path: '/root/button.ts', score: 1.0, root: '/root' },
        { path: '/root/butterfly.ts', score: 0.9, root: '/root' },
        { path: '/root/butler.ts', score: 0.8, root: '/root' },
      ]
      cache.store('but', '/root', results)

      // Extend query to "button" - should filter to only button.ts
      const filtered = cache.tryFilter('button', '/root', r => r.path.includes('button'))

      expect(filtered).toBeDefined()
      expect(filtered!.length).toBe(1)
      expect(filtered![0]!.path).toBe('/root/button.ts')
    })

    test('chains multiple extensions', () => {
      // Store results for "b"
      const results: DaemonSearchResult[] = [
        { path: '/root/button.ts', score: 1.0, root: '/root' },
        { path: '/root/butterfly.ts', score: 0.9, root: '/root' },
        { path: '/root/butler.ts', score: 0.8, root: '/root' },
        { path: '/root/box.ts', score: 0.7, root: '/root' },
      ]
      cache.store('b', '/root', results)

      // First extension: "bu"
      const filtered1 = cache.tryFilter('bu', '/root', r => r.path.includes('bu'))
      expect(filtered1).toBeDefined()
      expect(filtered1!.length).toBe(3) // button, butterfly, butler

      // Second extension: "but"
      const filtered2 = cache.tryFilter('but', '/root', r => r.path.includes('but'))
      expect(filtered2).toBeDefined()
      expect(filtered2!.length).toBe(3) // button, butterfly, butler

      // Third extension: "butt"
      const filtered3 = cache.tryFilter('butt', '/root', r => r.path.includes('butt'))
      expect(filtered3).toBeDefined()
      expect(filtered3!.length).toBe(2) // button, butterfly
    })
  })

  describe('expiration', () => {
    test('expires after TTL', async () => {
      const cache = new PrefixCache({ ttlMs: 100 })
      const results = createMockResults(3, 'button')

      cache.store('button', '/root', results)
      expect(cache.tryFilter('buttoni', '/root', () => true)).toBeDefined()

      // Wait for TTL
      await Bun.sleep(150)

      expect(cache.tryFilter('buttoni', '/root', () => true)).toBeUndefined()
    })
  })

  describe('clear', () => {
    test('removes entry', () => {
      const results = createMockResults(3, 'button')
      cache.store('button', '/root', results)

      expect(cache.tryFilter('buttoni', '/root', () => true)).toBeDefined()

      cache.clear()

      expect(cache.tryFilter('buttoni', '/root', () => true)).toBeUndefined()
    })
  })

  describe('currentQuery', () => {
    test('returns undefined when empty', () => {
      expect(cache.currentQuery).toBeUndefined()
    })

    test('returns stored query', () => {
      const results = createMockResults(3)
      cache.store('button', '/root', results)

      expect(cache.currentQuery).toBe('button')
    })

    test('returns undefined after clear', () => {
      const results = createMockResults(3)
      cache.store('button', '/root', results)
      cache.clear()

      expect(cache.currentQuery).toBeUndefined()
    })
  })
})
