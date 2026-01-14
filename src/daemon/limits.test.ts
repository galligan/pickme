/**
 * Tests for query limit calculation.
 *
 * @module daemon/limits.test
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULT_MAX_LIMIT, getEffectiveLimit, getSearchableLength } from './limits'

// ============================================================================
// getEffectiveLimit Tests
// ============================================================================

describe('getEffectiveLimit', () => {
  test('1-2 char queries get limit 10', () => {
    expect(getEffectiveLimit(1)).toBe(10)
    expect(getEffectiveLimit(2)).toBe(10)
  })

  test('3-4 char queries get limit 25', () => {
    expect(getEffectiveLimit(3)).toBe(25)
    expect(getEffectiveLimit(4)).toBe(25)
  })

  test('5+ char queries get limit 50', () => {
    expect(getEffectiveLimit(5)).toBe(50)
    expect(getEffectiveLimit(10)).toBe(50)
    expect(getEffectiveLimit(100)).toBe(50)
  })

  test('respects user-requested limit when lower than base', () => {
    expect(getEffectiveLimit(5, 20)).toBe(20)
    expect(getEffectiveLimit(10, 30)).toBe(30)
  })

  test('caps user-requested limit to base limit', () => {
    expect(getEffectiveLimit(2, 100)).toBe(10) // 2 chars -> max 10
    expect(getEffectiveLimit(3, 100)).toBe(25) // 3-4 chars -> max 25
    expect(getEffectiveLimit(5, 100)).toBe(50) // 5+ chars -> max 50
  })

  test('respects maxLimit parameter', () => {
    expect(getEffectiveLimit(10, undefined, 30)).toBe(30)
    expect(getEffectiveLimit(5, undefined, 20)).toBe(20)
  })

  test('uses smallest of requestedLimit, baseLimit, and maxLimit', () => {
    // requestedLimit is smallest
    expect(getEffectiveLimit(5, 15, 100)).toBe(15)
    // baseLimit is smallest
    expect(getEffectiveLimit(2, 100, 100)).toBe(10)
    // maxLimit is smallest
    expect(getEffectiveLimit(10, 100, 25)).toBe(25)
  })

  test('zero query length gets limit 10', () => {
    expect(getEffectiveLimit(0)).toBe(10)
  })

  test('DEFAULT_MAX_LIMIT is 50', () => {
    expect(DEFAULT_MAX_LIMIT).toBe(50)
  })
})

// ============================================================================
// getSearchableLength Tests
// ============================================================================

describe('getSearchableLength', () => {
  test('plain queries use full length', () => {
    expect(getSearchableLength('readme')).toBe(6)
    expect(getSearchableLength('test')).toBe(4)
    expect(getSearchableLength('a')).toBe(1)
  })

  test('namespace prefix is stripped', () => {
    expect(getSearchableLength('@docs:readme')).toBe(6)
    expect(getSearchableLength('@:test')).toBe(4)
    expect(getSearchableLength('@project:src')).toBe(3)
    expect(getSearchableLength('@dev:index.ts')).toBe(8)
  })

  test('handles empty search part', () => {
    expect(getSearchableLength('@docs:')).toBe(0)
    expect(getSearchableLength('')).toBe(0)
  })

  test('handles empty namespace', () => {
    expect(getSearchableLength('@:file')).toBe(4)
  })

  test('trims whitespace', () => {
    expect(getSearchableLength('  test  ')).toBe(4)
    expect(getSearchableLength('@docs:  readme  ')).toBe(6)
  })

  test('does not strip @ if not a namespace prefix', () => {
    // @ without : is not a namespace prefix
    expect(getSearchableLength('@test')).toBe(5)
    expect(getSearchableLength('test@example')).toBe(12)
  })
})
