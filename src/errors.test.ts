/**
 * Tests for error handling utilities.
 *
 * Tests custom error types, type guards, pattern matching, and error wrapping.
 *
 * @module errors.test
 */

import { describe, test, expect } from 'bun:test'
import {
  ErrorCode,
  FilePickerError,
  DatabaseError,
  GitError,
  FTSSyntaxError,
  TimeoutError,
  ConfigError,
  isFilePickerError,
  isDatabaseError,
  isGitError,
  isFTSSyntaxError,
  isTimeoutError,
  isConfigError,
  ErrorPatterns,
  matchesErrorPattern,
  wrapError,
  ensureError,
} from './errors'

// ============================================================================
// ErrorCode Tests
// ============================================================================

describe('ErrorCode', () => {
  test('has expected error codes', () => {
    expect(ErrorCode.DATABASE_ERROR).toBe('DATABASE_ERROR')
    expect(ErrorCode.GIT_ERROR).toBe('GIT_ERROR')
    expect(ErrorCode.FTS_SYNTAX_ERROR).toBe('FTS_SYNTAX_ERROR')
    expect(ErrorCode.TIMEOUT_ERROR).toBe('TIMEOUT_ERROR')
    expect(ErrorCode.CONFIG_ERROR).toBe('CONFIG_ERROR')
  })
})

// ============================================================================
// DatabaseError Tests
// ============================================================================

describe('DatabaseError', () => {
  test('creates error with message', () => {
    const err = new DatabaseError('test error')
    expect(err.message).toBe('test error')
    expect(err.code).toBe(ErrorCode.DATABASE_ERROR)
    expect(err.name).toBe('DatabaseError')
  })

  test('includes cause when provided', () => {
    const cause = new Error('underlying cause')
    const err = new DatabaseError('test error', { cause })
    expect(err.cause).toBe(cause)
  })

  test('fromSqliteError creates error with cause', () => {
    const sqliteErr = new Error('SQLITE_BUSY')
    const err = DatabaseError.fromSqliteError(sqliteErr)
    expect(err.message).toContain('SQLite error')
    expect(err.message).toContain('SQLITE_BUSY')
    expect(err.cause).toBe(sqliteErr)
  })

  test('connectionFailed creates error with path', () => {
    const err = DatabaseError.connectionFailed('/path/to/db.sqlite')
    expect(err.message).toContain('/path/to/db.sqlite')
    expect(err.message).toContain('Failed to connect')
  })

  test('connectionFailed includes cause when provided', () => {
    const cause = new Error('ENOENT')
    const err = DatabaseError.connectionFailed('/path/to/db.sqlite', cause)
    expect(err.cause).toBe(cause)
  })

  test('locked creates error with path', () => {
    const err = DatabaseError.locked('/path/to/db.sqlite')
    expect(err.message).toContain('locked')
    expect(err.message).toContain('/path/to/db.sqlite')
  })

  test('toDetailedString formats error with code', () => {
    const err = new DatabaseError('test error')
    const detailed = err.toDetailedString()
    expect(detailed).toContain('DatabaseError')
    expect(detailed).toContain('DATABASE_ERROR')
    expect(detailed).toContain('test error')
  })

  test('toDetailedString includes cause', () => {
    const cause = new Error('underlying')
    const err = new DatabaseError('test error', { cause })
    const detailed = err.toDetailedString()
    expect(detailed).toContain('Caused by')
    expect(detailed).toContain('underlying')
  })
})

// ============================================================================
// GitError Tests
// ============================================================================

describe('GitError', () => {
  test('creates error with message', () => {
    const err = new GitError('test error')
    expect(err.message).toBe('test error')
    expect(err.code).toBe(ErrorCode.GIT_ERROR)
    expect(err.name).toBe('GitError')
  })

  test('commandFailed creates error with command and stderr', () => {
    const err = GitError.commandFailed('git status', 'fatal: not a git repository')
    expect(err.message).toContain('git status')
    expect(err.message).toContain('fatal: not a git repository')
  })

  test('commandFailed includes cause when provided', () => {
    const cause = new Error('spawn failed')
    const err = GitError.commandFailed('git status', 'stderr', cause)
    expect(err.cause).toBe(cause)
  })

  test('notAvailable creates descriptive error', () => {
    const err = GitError.notAvailable()
    expect(err.message).toContain('git')
    expect(err.message).toContain('not installed')
  })

  test('notARepository creates error with path', () => {
    const err = GitError.notARepository('/path/to/dir')
    expect(err.message).toContain('Not a git repository')
    expect(err.message).toContain('/path/to/dir')
  })
})

// ============================================================================
// FTSSyntaxError Tests
// ============================================================================

describe('FTSSyntaxError', () => {
  test('creates error with message and query', () => {
    const err = new FTSSyntaxError('syntax error', 'bad query')
    expect(err.message).toBe('syntax error')
    expect(err.query).toBe('bad query')
    expect(err.code).toBe(ErrorCode.FTS_SYNTAX_ERROR)
    expect(err.name).toBe('FTSSyntaxError')
  })

  test('fromSqliteError creates error with query', () => {
    const sqliteErr = new Error('fts5: syntax error near ")"')
    const err = FTSSyntaxError.fromSqliteError(sqliteErr, 'test query()')
    expect(err.message).toContain('FTS5 syntax error')
    expect(err.message).toContain('test query()')
    expect(err.query).toBe('test query()')
    expect(err.cause).toBe(sqliteErr)
  })
})

// ============================================================================
// TimeoutError Tests
// ============================================================================

describe('TimeoutError', () => {
  test('creates error with message and timeout', () => {
    const err = new TimeoutError('operation timed out', 100)
    expect(err.message).toBe('operation timed out')
    expect(err.timeoutMs).toBe(100)
    expect(err.code).toBe(ErrorCode.TIMEOUT_ERROR)
    expect(err.name).toBe('TimeoutError')
  })

  test('queryTimeout creates error with timeout value', () => {
    const err = TimeoutError.queryTimeout(50)
    expect(err.message).toContain('Query')
    expect(err.message).toContain('50ms')
    expect(err.timeoutMs).toBe(50)
  })

  test('indexTimeout creates error with timeout value', () => {
    const err = TimeoutError.indexTimeout(5000)
    expect(err.message).toContain('Indexing')
    expect(err.message).toContain('5000ms')
    expect(err.timeoutMs).toBe(5000)
  })
})

// ============================================================================
// ConfigError Tests
// ============================================================================

describe('ConfigError', () => {
  test('creates error with message', () => {
    const err = new ConfigError('config error')
    expect(err.message).toBe('config error')
    expect(err.code).toBe(ErrorCode.CONFIG_ERROR)
    expect(err.name).toBe('ConfigError')
  })

  test('parseError creates error with path and cause', () => {
    const cause = new Error('invalid toml')
    const err = ConfigError.parseError('/path/to/config.toml', cause)
    expect(err.message).toContain('Failed to parse')
    expect(err.message).toContain('/path/to/config.toml')
    expect(err.cause).toBe(cause)
  })

  test('validationError creates descriptive error', () => {
    const err = ConfigError.validationError('weights.git_recency must be non-negative')
    expect(err.message).toContain('Invalid configuration')
    expect(err.message).toContain('weights.git_recency')
  })
})

// ============================================================================
// Type Guards Tests
// ============================================================================

describe('type guards', () => {
  describe('isFilePickerError', () => {
    test('returns true for FilePickerError subclasses', () => {
      expect(isFilePickerError(new DatabaseError('test'))).toBe(true)
      expect(isFilePickerError(new GitError('test'))).toBe(true)
      expect(isFilePickerError(new FTSSyntaxError('test', 'query'))).toBe(true)
      expect(isFilePickerError(new TimeoutError('test', 100))).toBe(true)
      expect(isFilePickerError(new ConfigError('test'))).toBe(true)
    })

    test('returns false for regular errors', () => {
      expect(isFilePickerError(new Error('test'))).toBe(false)
      expect(isFilePickerError(new TypeError('test'))).toBe(false)
    })

    test('returns false for non-errors', () => {
      expect(isFilePickerError('string')).toBe(false)
      expect(isFilePickerError(null)).toBe(false)
      expect(isFilePickerError(undefined)).toBe(false)
      expect(isFilePickerError({})).toBe(false)
    })
  })

  describe('isDatabaseError', () => {
    test('returns true for DatabaseError', () => {
      expect(isDatabaseError(new DatabaseError('test'))).toBe(true)
    })

    test('returns false for other FilePickerErrors', () => {
      expect(isDatabaseError(new GitError('test'))).toBe(false)
      expect(isDatabaseError(new ConfigError('test'))).toBe(false)
    })

    test('returns false for regular errors', () => {
      expect(isDatabaseError(new Error('test'))).toBe(false)
    })
  })

  describe('isGitError', () => {
    test('returns true for GitError', () => {
      expect(isGitError(new GitError('test'))).toBe(true)
    })

    test('returns false for other errors', () => {
      expect(isGitError(new DatabaseError('test'))).toBe(false)
      expect(isGitError(new Error('test'))).toBe(false)
    })
  })

  describe('isFTSSyntaxError', () => {
    test('returns true for FTSSyntaxError', () => {
      expect(isFTSSyntaxError(new FTSSyntaxError('test', 'query'))).toBe(true)
    })

    test('returns false for other errors', () => {
      expect(isFTSSyntaxError(new DatabaseError('test'))).toBe(false)
      expect(isFTSSyntaxError(new Error('test'))).toBe(false)
    })
  })

  describe('isTimeoutError', () => {
    test('returns true for TimeoutError', () => {
      expect(isTimeoutError(new TimeoutError('test', 100))).toBe(true)
    })

    test('returns false for other errors', () => {
      expect(isTimeoutError(new DatabaseError('test'))).toBe(false)
      expect(isTimeoutError(new Error('test'))).toBe(false)
    })
  })

  describe('isConfigError', () => {
    test('returns true for ConfigError', () => {
      expect(isConfigError(new ConfigError('test'))).toBe(true)
    })

    test('returns false for other errors', () => {
      expect(isConfigError(new DatabaseError('test'))).toBe(false)
      expect(isConfigError(new Error('test'))).toBe(false)
    })
  })
})

// ============================================================================
// ErrorPatterns Tests
// ============================================================================

describe('ErrorPatterns', () => {
  test('FTS5_SYNTAX matches FTS5 syntax errors', () => {
    expect(ErrorPatterns.FTS5_SYNTAX.test('fts5: syntax error')).toBe(true)
    expect(ErrorPatterns.FTS5_SYNTAX.test('FTS5: SYNTAX ERROR')).toBe(true)
    expect(ErrorPatterns.FTS5_SYNTAX.test('some other error')).toBe(false)
  })

  test('DATABASE_LOCKED matches locked database errors', () => {
    expect(ErrorPatterns.DATABASE_LOCKED.test('database is locked')).toBe(true)
    expect(ErrorPatterns.DATABASE_LOCKED.test('DATABASE IS LOCKED')).toBe(true)
    expect(ErrorPatterns.DATABASE_LOCKED.test('some other error')).toBe(false)
  })

  test('DATABASE_CORRUPT matches corruption errors', () => {
    expect(ErrorPatterns.DATABASE_CORRUPT.test('database disk image is malformed')).toBe(true)
    expect(ErrorPatterns.DATABASE_CORRUPT.test('DATABASE DISK IMAGE IS MALFORMED')).toBe(true)
    expect(ErrorPatterns.DATABASE_CORRUPT.test('some other error')).toBe(false)
  })

  test('NOT_A_GIT_REPO matches git repo errors', () => {
    expect(ErrorPatterns.NOT_A_GIT_REPO.test('not a git repository')).toBe(true)
    expect(ErrorPatterns.NOT_A_GIT_REPO.test('NOT A GIT REPOSITORY')).toBe(true)
    expect(ErrorPatterns.NOT_A_GIT_REPO.test('some other error')).toBe(false)
  })

  test('GIT_NOT_FOUND matches git not found errors', () => {
    expect(ErrorPatterns.GIT_NOT_FOUND.test('git: command not found')).toBe(true)
    expect(ErrorPatterns.GIT_NOT_FOUND.test('git is not recognized')).toBe(true)
    expect(ErrorPatterns.GIT_NOT_FOUND.test('some other error')).toBe(false)
  })
})

// ============================================================================
// matchesErrorPattern Tests
// ============================================================================

describe('matchesErrorPattern', () => {
  test('matches Error instances', () => {
    const err = new Error('fts5: syntax error')
    expect(matchesErrorPattern(err, ErrorPatterns.FTS5_SYNTAX)).toBe(true)
  })

  test('matches string errors', () => {
    expect(matchesErrorPattern('database is locked', ErrorPatterns.DATABASE_LOCKED)).toBe(true)
  })

  test('returns false for non-matching Error', () => {
    const err = new Error('some other error')
    expect(matchesErrorPattern(err, ErrorPatterns.FTS5_SYNTAX)).toBe(false)
  })

  test('returns false for non-matching string', () => {
    expect(matchesErrorPattern('some other error', ErrorPatterns.DATABASE_LOCKED)).toBe(false)
  })

  test('returns false for null/undefined', () => {
    expect(matchesErrorPattern(null, ErrorPatterns.FTS5_SYNTAX)).toBe(false)
    expect(matchesErrorPattern(undefined, ErrorPatterns.FTS5_SYNTAX)).toBe(false)
  })

  test('returns false for objects without message', () => {
    expect(matchesErrorPattern({}, ErrorPatterns.FTS5_SYNTAX)).toBe(false)
    expect(matchesErrorPattern({ foo: 'bar' }, ErrorPatterns.FTS5_SYNTAX)).toBe(false)
  })
})

// ============================================================================
// wrapError Tests
// ============================================================================

describe('wrapError', () => {
  test('returns FilePickerError as-is', () => {
    const original = new DatabaseError('test')
    const wrapped = wrapError(original)
    expect(wrapped).toBe(original)
  })

  test('wraps FTS5 syntax error', () => {
    const err = new Error('fts5: syntax error near ")"')
    const wrapped = wrapError(err, { query: 'test query' })
    expect(isFTSSyntaxError(wrapped)).toBe(true)
    if (isFTSSyntaxError(wrapped)) {
      expect(wrapped.query).toBe('test query')
    }
  })

  test('wraps database locked error', () => {
    const err = new Error('database is locked')
    const wrapped = wrapError(err)
    expect(isDatabaseError(wrapped)).toBe(true)
  })

  test('wraps database corrupt error', () => {
    const err = new Error('database disk image is malformed')
    const wrapped = wrapError(err)
    expect(isDatabaseError(wrapped)).toBe(true)
  })

  test('wraps git not a repository error', () => {
    const err = new Error('fatal: not a git repository')
    const wrapped = wrapError(err)
    expect(isGitError(wrapped)).toBe(true)
  })

  test('wraps git not found error', () => {
    const err = new Error('git: command not found')
    const wrapped = wrapError(err)
    expect(isGitError(wrapped)).toBe(true)
  })

  test('returns original error if no pattern matches', () => {
    const err = new Error('some unknown error')
    const wrapped = wrapError(err)
    expect(wrapped).toBe(err)
  })

  test('wraps non-Error in Error', () => {
    const wrapped = wrapError('string error')
    expect(wrapped instanceof Error).toBe(true)
    expect(wrapped.message).toBe('string error')
  })

  test('wraps null/undefined in Error', () => {
    const wrappedNull = wrapError(null)
    expect(wrappedNull instanceof Error).toBe(true)
    expect(wrappedNull.message).toBe('null')

    const wrappedUndefined = wrapError(undefined)
    expect(wrappedUndefined instanceof Error).toBe(true)
    expect(wrappedUndefined.message).toBe('undefined')
  })

  test('uses <unknown> for query when not provided', () => {
    const err = new Error('fts5: syntax error')
    const wrapped = wrapError(err)
    expect(isFTSSyntaxError(wrapped)).toBe(true)
    if (isFTSSyntaxError(wrapped)) {
      expect(wrapped.query).toBe('<unknown>')
    }
  })
})

// ============================================================================
// ensureError Tests
// ============================================================================

describe('ensureError', () => {
  test('returns Error instances as-is', () => {
    const err = new Error('test')
    expect(ensureError(err)).toBe(err)
  })

  test('returns FilePickerError instances as-is', () => {
    const err = new DatabaseError('test')
    expect(ensureError(err)).toBe(err)
  })

  test('wraps string in Error', () => {
    const result = ensureError('string error')
    expect(result instanceof Error).toBe(true)
    expect(result.message).toBe('string error')
  })

  test('wraps number in Error', () => {
    const result = ensureError(42)
    expect(result instanceof Error).toBe(true)
    expect(result.message).toBe('42')
  })

  test('wraps null in Error', () => {
    const result = ensureError(null)
    expect(result instanceof Error).toBe(true)
    expect(result.message).toBe('null')
  })

  test('wraps undefined in Error', () => {
    const result = ensureError(undefined)
    expect(result instanceof Error).toBe(true)
    expect(result.message).toBe('undefined')
  })

  test('wraps objects in Error', () => {
    const result = ensureError({ foo: 'bar' })
    expect(result instanceof Error).toBe(true)
    expect(result.message).toBe('[object Object]')
  })
})
