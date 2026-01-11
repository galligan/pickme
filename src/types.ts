/**
 * Shared type definitions for the Claude Code file picker.
 *
 * This module contains types that are used across multiple modules to avoid
 * circular imports and eliminate duplicate type definitions.
 *
 * @module types
 */

// ============================================================================
// File Metadata Types
// ============================================================================

/**
 * Metadata for a file in the index.
 */
export interface FileMeta {
  /** Absolute path to the file */
  path: string
  /** Basename of the file (e.g., "Button.tsx") */
  filename: string
  /** Space-separated path components for FTS matching */
  dirComponents: string
  /** Root directory this file belongs to */
  root: string
  /** File modification time as Unix timestamp (seconds) */
  mtime: number
  /** Path relative to the root directory (for display) */
  relativePath: string
}

// ============================================================================
// Frecency Types
// ============================================================================

/**
 * Frecency record for ranking search results.
 */
export interface FrecencyRecord {
  /** Absolute path to the file */
  readonly path: string
  /** Recency score based on git commit history (0-1, exponential decay) */
  readonly gitRecency: number
  /** Number of commits touching this file within the time window */
  readonly gitFrequency: number
  /** Boost for files appearing in git status (modified/staged/untracked) */
  readonly gitStatusBoost: number
  /** Unix timestamp of when this record was last updated */
  readonly lastSeen: number
}

// ============================================================================
// Watched Root Types
// ============================================================================

/**
 * Metadata for a watched root directory.
 */
export interface WatchedRoot {
  /** Absolute path to the root directory */
  readonly root: string
  /** Maximum depth for indexing */
  readonly maxDepth: number
  /** Unix timestamp of last index operation */
  readonly lastIndexed: number | null
  /** Number of files indexed under this root */
  readonly fileCount: number | null
}

// ============================================================================
// Search Types
// ============================================================================

/**
 * A search result with score.
 */
export interface SearchResult {
  /** Absolute path to the file */
  readonly path: string
  /** Basename of the file */
  readonly filename: string
  /** Path relative to the root (for display) */
  readonly relativePath: string
  /** Combined FTS + frecency score */
  readonly score: number
}

/**
 * Options for searching files.
 */
export interface SearchOptions {
  /** Path prefixes to filter results (e.g., ["/Users/mg/Developer"]) */
  readonly pathFilters?: readonly string[]
  /** Maximum number of results to return (default: 50) */
  readonly limit?: number
}
