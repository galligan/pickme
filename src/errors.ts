/**
 * Error handling utilities for the Claude Code file picker.
 *
 * Provides custom error types for distinct failure modes and type guards
 * for discriminating between error types in catch blocks.
 *
 * @module errors
 */

/**
 * Error codes for categorizing file picker errors.
 * Used for programmatic error handling and logging.
 */
export const ErrorCode = {
  DATABASE_ERROR: 'DATABASE_ERROR',
  GIT_ERROR: 'GIT_ERROR',
  FTS_SYNTAX_ERROR: 'FTS_SYNTAX_ERROR',
  TIMEOUT_ERROR: 'TIMEOUT_ERROR',
  CONFIG_ERROR: 'CONFIG_ERROR',
} as const

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/**
 * Base error class for file picker errors.
 * Provides a common interface with error codes and cause chaining.
 */
export abstract class FilePickerError extends Error {
  abstract readonly code: ErrorCode
  readonly cause?: Error

  constructor(message: string, options?: { cause?: Error }) {
    super(message)
    this.name = this.constructor.name
    this.cause = options?.cause

    // Maintains proper stack trace for where error was thrown (V8 only)
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor)
    }
  }

  /**
   * Returns a formatted string including cause chain for logging.
   */
  toDetailedString(): string {
    let result = `${this.name} [${this.code}]: ${this.message}`
    if (this.cause) {
      result += `\n  Caused by: ${this.cause.message}`
    }
    return result
  }
}

/**
 * Error thrown when SQLite database operations fail.
 *
 * Examples:
 * - Database file is locked by another process
 * - Corrupted database file
 * - Schema migration failures
 * - WAL checkpoint failures
 */
export class DatabaseError extends FilePickerError {
  readonly code = ErrorCode.DATABASE_ERROR

  constructor(message: string, options?: { cause?: Error }) {
    super(message, options)
  }

  /**
   * Creates a DatabaseError from a SQLite error.
   */
  static fromSqliteError(err: Error): DatabaseError {
    return new DatabaseError(`SQLite error: ${err.message}`, { cause: err })
  }

  /**
   * Creates a DatabaseError for connection failures.
   */
  static connectionFailed(path: string, cause?: Error): DatabaseError {
    return new DatabaseError(`Failed to connect to database at ${path}`, {
      cause,
    })
  }

  /**
   * Creates a DatabaseError for locked database.
   */
  static locked(path: string): DatabaseError {
    return new DatabaseError(`Database is locked: ${path}`)
  }
}

/**
 * Error thrown when git commands fail or git is unavailable.
 *
 * Examples:
 * - git not installed
 * - Not a git repository
 * - git log/status command failures
 * - Permission errors on .git directory
 */
export class GitError extends FilePickerError {
  readonly code = ErrorCode.GIT_ERROR

  constructor(message: string, options?: { cause?: Error }) {
    super(message, options)
  }

  /**
   * Creates a GitError for command execution failures.
   */
  static commandFailed(
    command: string,
    stderr: string,
    cause?: Error
  ): GitError {
    return new GitError(`git command failed: ${command}\n${stderr}`, { cause })
  }

  /**
   * Creates a GitError when git is not available.
   */
  static notAvailable(): GitError {
    return new GitError('git is not installed or not in PATH')
  }

  /**
   * Creates a GitError when directory is not a git repository.
   */
  static notARepository(path: string): GitError {
    return new GitError(`Not a git repository: ${path}`)
  }
}

/**
 * Error thrown when FTS5 query syntax is invalid.
 *
 * SQLite FTS5 has specific query syntax rules. Malformed queries
 * (unbalanced quotes, invalid operators) throw syntax errors.
 *
 * The query client should catch these and retry with escaped input.
 */
export class FTSSyntaxError extends FilePickerError {
  readonly code = ErrorCode.FTS_SYNTAX_ERROR
  readonly query: string

  constructor(message: string, query: string, options?: { cause?: Error }) {
    super(message, options)
    this.query = query
  }

  /**
   * Creates an FTSSyntaxError from a SQLite FTS5 error.
   */
  static fromSqliteError(err: Error, query: string): FTSSyntaxError {
    return new FTSSyntaxError(
      `FTS5 syntax error in query "${query}": ${err.message}`,
      query,
      { cause: err }
    )
  }
}

/**
 * Error thrown when an operation exceeds its time budget.
 *
 * The file picker has a strict 100ms latency budget for queries.
 * Operations that exceed this should timeout gracefully.
 */
export class TimeoutError extends FilePickerError {
  readonly code = ErrorCode.TIMEOUT_ERROR
  readonly timeoutMs: number

  constructor(message: string, timeoutMs: number, options?: { cause?: Error }) {
    super(message, options)
    this.timeoutMs = timeoutMs
  }

  /**
   * Creates a TimeoutError for query operations.
   */
  static queryTimeout(timeoutMs: number): TimeoutError {
    return new TimeoutError(
      `Query exceeded ${timeoutMs}ms timeout`,
      timeoutMs
    )
  }

  /**
   * Creates a TimeoutError for indexing operations.
   */
  static indexTimeout(timeoutMs: number): TimeoutError {
    return new TimeoutError(
      `Indexing exceeded ${timeoutMs}ms timeout`,
      timeoutMs
    )
  }
}

/**
 * Error thrown when configuration is invalid or cannot be loaded.
 */
export class ConfigError extends FilePickerError {
  readonly code = ErrorCode.CONFIG_ERROR

  constructor(message: string, options?: { cause?: Error }) {
    super(message, options)
  }

  /**
   * Creates a ConfigError for TOML parsing failures.
   */
  static parseError(path: string, cause: Error): ConfigError {
    return new ConfigError(`Failed to parse config at ${path}`, { cause })
  }

  /**
   * Creates a ConfigError for validation failures.
   */
  static validationError(message: string): ConfigError {
    return new ConfigError(`Invalid configuration: ${message}`)
  }
}

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for FilePickerError base class.
 */
export function isFilePickerError(err: unknown): err is FilePickerError {
  return err instanceof FilePickerError
}

/**
 * Type guard for DatabaseError.
 */
export function isDatabaseError(err: unknown): err is DatabaseError {
  return err instanceof DatabaseError
}

/**
 * Type guard for GitError.
 */
export function isGitError(err: unknown): err is GitError {
  return err instanceof GitError
}

/**
 * Type guard for FTSSyntaxError.
 */
export function isFTSSyntaxError(err: unknown): err is FTSSyntaxError {
  return err instanceof FTSSyntaxError
}

/**
 * Type guard for TimeoutError.
 */
export function isTimeoutError(err: unknown): err is TimeoutError {
  return err instanceof TimeoutError
}

/**
 * Type guard for ConfigError.
 */
export function isConfigError(err: unknown): err is ConfigError {
  return err instanceof ConfigError
}

// ============================================================================
// Error Pattern Matching
// ============================================================================

/**
 * Patterns for detecting specific error conditions from raw errors.
 * Used when wrapping errors from external sources (SQLite, git, etc.).
 */
export const ErrorPatterns = {
  /** SQLite FTS5 syntax error pattern */
  FTS5_SYNTAX: /fts5:\s*syntax\s*error/i,

  /** SQLite database locked pattern */
  DATABASE_LOCKED: /database\s+is\s+locked/i,

  /** SQLite database corrupted pattern */
  DATABASE_CORRUPT: /database\s+disk\s+image\s+is\s+malformed/i,

  /** Git not a repository pattern */
  NOT_A_GIT_REPO: /not\s+a\s+git\s+repository/i,

  /** Git command not found pattern */
  GIT_NOT_FOUND: /git:\s*command\s+not\s+found|git\s+is\s+not\s+recognized/i,
} as const

/**
 * Checks if an error message matches a specific pattern.
 *
 * @param err - The error to check
 * @param pattern - Regex pattern to match against
 * @returns true if the error message matches the pattern
 *
 * @example
 * ```ts
 * if (matchesErrorPattern(err, ErrorPatterns.FTS5_SYNTAX)) {
 *   return FTSSyntaxError.fromSqliteError(err, query)
 * }
 * ```
 */
export function matchesErrorPattern(
  err: unknown,
  pattern: RegExp
): err is Error {
  if (err instanceof Error) {
    return pattern.test(err.message)
  }
  if (typeof err === 'string') {
    return pattern.test(err)
  }
  return false
}

/**
 * Wraps a raw error into the appropriate FilePickerError subclass
 * based on error message pattern matching.
 *
 * @param err - The raw error to wrap
 * @param context - Optional context for better error messages
 * @returns A FilePickerError subclass or the original error if unrecognized
 *
 * @example
 * ```ts
 * try {
 *   await db.query(sql)
 * } catch (err) {
 *   throw wrapError(err, { query: sql })
 * }
 * ```
 */
export function wrapError(
  err: unknown,
  context?: { query?: string }
): Error {
  // Already a FilePickerError, return as-is
  if (isFilePickerError(err)) {
    return err
  }

  // Not an Error, wrap in generic Error
  if (!(err instanceof Error)) {
    return new Error(String(err))
  }

  // Check for FTS5 syntax errors
  if (matchesErrorPattern(err, ErrorPatterns.FTS5_SYNTAX)) {
    return FTSSyntaxError.fromSqliteError(err, context?.query ?? '<unknown>')
  }

  // Check for database locked
  if (matchesErrorPattern(err, ErrorPatterns.DATABASE_LOCKED)) {
    return DatabaseError.locked('<unknown>')
  }

  // Check for database corruption
  if (matchesErrorPattern(err, ErrorPatterns.DATABASE_CORRUPT)) {
    return DatabaseError.fromSqliteError(err)
  }

  // Check for git repository errors
  if (matchesErrorPattern(err, ErrorPatterns.NOT_A_GIT_REPO)) {
    return GitError.notARepository('<unknown>')
  }

  // Check for git not installed
  if (matchesErrorPattern(err, ErrorPatterns.GIT_NOT_FOUND)) {
    return GitError.notAvailable()
  }

  // Return original error if no pattern matches
  return err
}

/**
 * Ensures an unknown value is an Error instance.
 * Useful for catch blocks with unknown type.
 *
 * @param err - The unknown value from a catch block
 * @returns An Error instance
 */
export function ensureError(err: unknown): Error {
  if (err instanceof Error) {
    return err
  }
  return new Error(String(err))
}
