/**
 * Tests for the query command.
 *
 * Tests argument parsing and validation for the query command.
 *
 * @module cli/commands/query.test
 */

import { describe, expect, test, beforeEach, afterEach, mock } from 'bun:test'
import { parseQueryArgs, QueryArgsError } from './query'

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Store original cwd for restoration.
 */
let originalCwd: () => string

beforeEach(() => {
  originalCwd = process.cwd
})

afterEach(() => {
  process.cwd = originalCwd
})

// ============================================================================
// parseQueryArgs Tests
// ============================================================================

describe('parseQueryArgs', () => {
  test('parses positional query pattern', () => {
    const result = parseQueryArgs(['my-pattern'])
    expect(result.query).toBe('my-pattern')
  })

  test('defaults cwd to process.cwd()', () => {
    const mockCwd = '/mock/working/dir'
    process.cwd = () => mockCwd

    const result = parseQueryArgs(['test-query'])
    expect(result.cwd).toBe(mockCwd)
  })

  test('defaults limit to 50', () => {
    const result = parseQueryArgs(['test-query'])
    expect(result.limit).toBe(50)
  })

  test('parses --cwd flag', () => {
    const result = parseQueryArgs(['test-query', '--cwd', '/custom/path'])
    expect(result.cwd).toBe('/custom/path')
  })

  test('parses -C short flag for cwd', () => {
    const result = parseQueryArgs(['test-query', '-C', '/short/path'])
    expect(result.cwd).toBe('/short/path')
  })

  test('parses --limit flag', () => {
    const result = parseQueryArgs(['test-query', '--limit', '100'])
    expect(result.limit).toBe(100)
  })

  test('parses -l short flag for limit', () => {
    const result = parseQueryArgs(['test-query', '-l', '25'])
    expect(result.limit).toBe(25)
  })

  test('parses --no-daemon flag', () => {
    const result = parseQueryArgs(['test-query', '--no-daemon'])
    expect(result.noDaemon).toBe(true)
  })

  test('defaults noDaemon to false', () => {
    const result = parseQueryArgs(['test-query'])
    expect(result.noDaemon).toBe(false)
  })

  test('throws QueryArgsError on missing query', () => {
    expect(() => parseQueryArgs([])).toThrow(QueryArgsError)
    expect(() => parseQueryArgs([])).toThrow('missing required argument: query pattern')
  })

  test('throws QueryArgsError on invalid limit (non-numeric)', () => {
    expect(() => parseQueryArgs(['test', '--limit', 'abc'])).toThrow(QueryArgsError)
    expect(() => parseQueryArgs(['test', '--limit', 'abc'])).toThrow('invalid limit: "abc"')
  })

  test('throws QueryArgsError on invalid limit (zero)', () => {
    expect(() => parseQueryArgs(['test', '--limit', '0'])).toThrow(QueryArgsError)
    expect(() => parseQueryArgs(['test', '--limit', '0'])).toThrow('invalid limit: "0"')
  })

  test('throws QueryArgsError on invalid limit (negative)', () => {
    expect(() => parseQueryArgs(['test', '--limit', '-5'])).toThrow(QueryArgsError)
    expect(() => parseQueryArgs(['test', '--limit', '-5'])).toThrow('invalid limit: "-5"')
  })

  test('throws QueryArgsError on invalid limit (float)', () => {
    expect(() => parseQueryArgs(['test', '--limit', '10.5'])).toThrow(QueryArgsError)
    expect(() => parseQueryArgs(['test', '--limit', '10.5'])).toThrow('invalid limit: "10.5"')
  })

  test('accepts valid integer limit', () => {
    const result = parseQueryArgs(['test', '--limit', '1'])
    expect(result.limit).toBe(1)
  })

  test('handles multiple flags together', () => {
    process.cwd = () => '/default'
    const result = parseQueryArgs([
      'my-query',
      '--cwd',
      '/custom',
      '--limit',
      '75',
      '--no-daemon',
    ])

    expect(result.query).toBe('my-query')
    expect(result.cwd).toBe('/custom')
    expect(result.limit).toBe(75)
    expect(result.noDaemon).toBe(true)
  })

  test('query can contain special characters', () => {
    const result = parseQueryArgs(['@*.tsx'])
    expect(result.query).toBe('@*.tsx')
  })

  test('query can contain spaces when quoted at shell level', () => {
    const result = parseQueryArgs(['hello world'])
    expect(result.query).toBe('hello world')
  })
})
