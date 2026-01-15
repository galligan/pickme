/**
 * Main entry point for the pickme file picker MCP server.
 *
 * Exposes a `createFilePicker` factory that provides fast file search
 * with FTS5 indexing and frecency-based ranking.
 *
 * @module index
 *
 * @example
 * ```ts
 * import { createFilePicker } from './index';
 *
 * const picker = await createFilePicker();
 *
 * // Search files
 * const results = await picker.search('button comp', {
 *   projectRoot: '/Users/mg/project',
 *   limit: 20,
 * });
 *
 * // Ensure roots are indexed
 * await picker.ensureIndexed(['/Users/mg/Developer']);
 *
 * // Refresh a specific root
 * await picker.refreshIndex('/Users/mg/project');
 *
 * // Clean up
 * await picker.close();
 * ```
 */

import type { Database } from 'bun:sqlite'
import {
  openDatabase,
  closeDatabase,
  searchFiles as dbSearchFiles,
  listFiles as dbListFiles,
  listFilesByExtension as dbListFilesByExtension,
  upsertFiles,
  deleteFiles,
  getWatchedRoots,
  updateWatchedRoot,
  upsertFrecency,
  getDefaultDbPath,
  type SearchResult as DbSearchResult,
  type FileMeta,
  type FrecencyRecord as DbFrecencyRecord,
  type WatchedRoot,
} from './db'
import { loadConfig, getDepthForRoot, expandTilde, type Config } from './config'
import { debugLog } from './utils'
import { parseQuery, resolvePrefix, type ParseResult, type ResolveResult } from './prefix'
import {
  indexDirectory,
  type IndexOptions,
  type IndexResult as IndexerResult,
  type DbOperations,
} from './indexer'
import { buildFrecencyRecords, type FrecencyRecord } from './frecency'
import { isGitRepo } from './git'
import { ensureError } from './errors'

// ============================================================================
// Type Definitions
// ============================================================================

/**
 * Options for creating a file picker instance.
 */
export interface FilePickerOptions {
  /** Path to the SQLite database (default: $XDG_DATA_HOME/pickme/index.db) */
  readonly dbPath?: string
  /** Path to the TOML config file (default: $XDG_CONFIG_HOME/pickme/config.toml) */
  readonly configPath?: string
}

/**
 * Options for searching files.
 */
export interface FilePickerSearchOptions {
  /** Current project root directory for context */
  readonly projectRoot?: string
  /** Additional directories to search */
  readonly additionalDirs?: readonly string[]
  /** Maximum number of results to return (default: 50) */
  readonly limit?: number
}

/**
 * A search result from the file picker.
 */
export interface FilePickerSearchResult {
  /** Absolute path to the file */
  readonly path: string
  /** Basename of the file */
  readonly filename: string
  /** Path relative to the project root (for display) */
  readonly relativePath: string
  /** Combined FTS + frecency score */
  readonly score: number
}

/**
 * Result of an indexing operation.
 */
export interface IndexResult {
  /** Number of files successfully indexed */
  readonly filesIndexed: number
  /** Number of files skipped */
  readonly filesSkipped: number
  /** Error messages encountered */
  readonly errors: readonly string[]
}

/**
 * Result of a refresh operation.
 */
export interface RefreshResult {
  /** Number of files indexed/updated */
  readonly filesIndexed: number
  /** Duration in milliseconds */
  readonly duration: number
  /** Error messages encountered */
  readonly errors: readonly string[]
}

/**
 * The file picker interface.
 */
export interface FilePicker {
  /**
   * Searches for files matching the query.
   *
   * Supports prefix syntax:
   * - `@namespace:query` - Search within a named namespace
   * - `@/folder:query` - Search within a folder
   * - `@*.ext` - Filter by file extension
   * - `@@literal` - Escape @ for literal search
   *
   * @param query - The search query
   * @param options - Search options
   * @returns Array of search results sorted by relevance
   */
  search(
    query: string,
    options?: FilePickerSearchOptions
  ): Promise<readonly FilePickerSearchResult[]>

  /**
   * Ensures the specified directories are indexed.
   *
   * Indexes directories that haven't been indexed yet.
   * For already-indexed directories, this is a no-op.
   *
   * @param roots - Array of directory paths to index
   * @returns Indexing result with statistics
   */
  ensureIndexed(roots: readonly string[]): Promise<IndexResult>

  /**
   * Refreshes the index for a specific directory.
   *
   * Re-scans the directory and updates the index with new/changed files.
   * Also prunes files that no longer exist.
   *
   * @param root - Directory path to refresh
   * @returns Refresh result with statistics
   */
  refreshIndex(root: string, options?: { force?: boolean }): Promise<RefreshResult>

  /**
   * Closes the file picker and releases resources.
   */
  close(): Promise<void>
}

// ============================================================================
// Database Operations Adapter
// ============================================================================

/**
 * Creates DbOperations adapter for the indexer.
 */
function createDbOperations(db: Database): DbOperations {
  return {
    upsertFiles: (database, files) => upsertFiles(database as Database, files),
    deleteFiles: (database, paths) => deleteFiles(database as Database, paths),
    updateWatchedRoot: (database, root) =>
      updateWatchedRoot(database as Database, {
        ...root,
        // Convert fileCount to nullable for db layer
        fileCount: root.fileCount,
      }),
    getWatchedRoots: database => {
      // Convert from db types (nullable) to indexer types (non-nullable)
      return getWatchedRoots(database as Database).map(wr => ({
        root: wr.root,
        maxDepth: wr.maxDepth,
        lastIndexed: wr.lastIndexed,
        fileCount: wr.fileCount ?? 0,
      }))
    },
    getFilesForRoot: (database, root) => {
      const rows = (database as Database)
        .query<{ path: string }, [string]>('SELECT path FROM files_meta WHERE root = ?')
        .all(root)
      return rows.map(r => r.path)
    },
  }
}

// ============================================================================
// File Picker Implementation
// ============================================================================

/**
 * Internal file picker implementation.
 */
class FilePickerImpl implements FilePicker {
  private readonly db: Database
  private readonly config: Config
  private readonly dbOps: DbOperations

  constructor(db: Database, config: Config) {
    this.db = db
    this.config = config
    this.dbOps = createDbOperations(db)
  }

  async search(
    query: string,
    options: FilePickerSearchOptions = {}
  ): Promise<readonly FilePickerSearchResult[]> {
    const { projectRoot, additionalDirs = [], limit = 50 } = options

    // Handle empty query
    if (!query.trim()) {
      return []
    }

    // Parse query for prefixes
    const parsed = parseQuery(query, this.config)
    let searchQuery = parsed.searchQuery

    const { pathFilters, patternFilters } = this.resolveFilters(parsed, {
      projectRoot: projectRoot ?? '',
      additionalDirs,
    })

    let isFuzzy = false
    if (searchQuery.startsWith('~')) {
      isFuzzy = true
      searchQuery = searchQuery.slice(1).trim()
    } else if (!parsed.prefix && query.startsWith('@~')) {
      isFuzzy = true
      searchQuery = query.slice(2).trim()
    }

    // If we have only a prefix with no search query, handle special cases
    if (!searchQuery && parsed.prefix) {
      // For glob patterns like @*.md, we need to search all files
      // and filter by the pattern
      if (parsed.prefix.type === 'glob') {
        return this.searchWithGlobFilter(parsed.prefix.pattern, options)
      }

      if (parsed.prefix.type === 'folder') {
        const folderQuery = parsed.prefix.folder.startsWith('.')
          ? parsed.prefix.folder.slice(1)
          : parsed.prefix.folder
        if (folderQuery) {
          searchQuery = folderQuery
        }
      }

      if (parsed.prefix.type === 'namespace') {
        searchQuery = parsed.prefix.name
      }
    }

    if (isFuzzy) {
      if (!searchQuery) {
        return []
      }
      return this.searchWithFuzzy(searchQuery, {
        pathFilters,
        patternFilters,
        limit,
      })
    }

    // Search the database
    const results = dbSearchFiles(this.db, searchQuery || query, {
      pathFilters: pathFilters.length > 0 ? pathFilters : undefined,
      limit,
    })

    const mapped = results.map(r => ({
      path: r.path,
      filename: r.filename,
      relativePath: r.relativePath,
      score: r.score,
    }))

    const filtered =
      patternFilters.length === 0 ? mapped : this.filterResultsByPatterns(mapped, patternFilters)

    if (filtered.length === 0) {
      const fallbackQuery = searchQuery || query
      if (fallbackQuery.trim()) {
        return this.searchWithFuzzy(fallbackQuery, {
          pathFilters,
          patternFilters,
          limit,
        })
      }
    }

    return filtered
  }

  /**
   * Searches with a glob filter pattern.
   * Uses direct file listing by extension since FTS5 requires a non-empty query.
   */
  private async searchWithGlobFilter(
    pattern: string,
    options: FilePickerSearchOptions
  ): Promise<readonly FilePickerSearchResult[]> {
    const { projectRoot, limit = 50 } = options

    // For @*.ext patterns, extract the extension (e.g., "*.ts" -> ".ts")
    const ext = pattern.replace('*.', '.')

    // Use direct file listing by extension (bypasses FTS5)
    const results = dbListFilesByExtension(this.db, ext, {
      pathFilters: projectRoot ? [projectRoot] : undefined,
      limit,
    })

    return results.map(r => ({
      path: r.path,
      filename: r.filename,
      relativePath: r.relativePath,
      score: r.score,
    }))
  }

  private async searchWithFuzzy(
    query: string,
    options: { pathFilters: readonly string[]; patternFilters: readonly string[]; limit: number }
  ): Promise<readonly FilePickerSearchResult[]> {
    const { pathFilters, patternFilters, limit } = options
    const candidateLimit = Math.min(Math.max(limit * 50, 500), 5000)
    const candidates = dbListFiles(this.db, {
      pathFilters: pathFilters.length > 0 ? pathFilters : undefined,
      limit: candidateLimit,
    })

    const filtered =
      patternFilters.length === 0
        ? candidates
        : this.filterResultsByPatterns(candidates, patternFilters)

    const scored = filtered
      .map(result => {
        const rel = normalizeRelativePath(result.relativePath ?? result.path)
        const name = result.filename
        const scorePath = fuzzyScoreTokens(query, rel)
        const scoreName = fuzzyScoreTokens(query, name)
        const best = Math.max(scorePath, scoreName * 1.2)
        if (best < 0) {
          return null
        }
        const combined = best + result.score * 0.2
        return {
          path: result.path,
          filename: result.filename,
          relativePath: result.relativePath,
          score: combined,
        }
      })
      .filter(Boolean) as FilePickerSearchResult[]

    scored.sort((a, b) => b.score - a.score || a.relativePath.localeCompare(b.relativePath))

    return scored.slice(0, limit)
  }

  /**
   * Resolves prefix filters into path filters and pattern filters.
   */
  private resolveFilters(
    parsed: ParseResult,
    context: { projectRoot: string; additionalDirs: readonly string[] }
  ): { pathFilters: string[]; patternFilters: string[] } {
    if (!parsed.prefix) {
      return {
        pathFilters: context.projectRoot ? [context.projectRoot] : [],
        patternFilters: [],
      }
    }

    try {
      const resolved = resolvePrefix(
        parsed.prefix,
        {
          projectRoot: context.projectRoot,
          additionalDirs: context.additionalDirs,
        },
        this.config
      )

      if (resolved.roots) {
        return { pathFilters: [...resolved.roots], patternFilters: [] }
      }

      if (resolved.patterns) {
        return {
          pathFilters: context.projectRoot ? [context.projectRoot] : [],
          patternFilters: [...resolved.patterns],
        }
      }
    } catch (err) {
      debugLog('prefix', 'Failed to resolve namespace', err)
    }

    return {
      pathFilters: context.projectRoot ? [context.projectRoot] : [],
      patternFilters: [],
    }
  }

  private filterResultsByPatterns(
    results: readonly FilePickerSearchResult[],
    patterns: readonly string[]
  ): readonly FilePickerSearchResult[] {
    const matchers = buildPatternMatchers(patterns)
    if (matchers.length === 0) {
      return results
    }

    return results.filter(result => {
      const rel = normalizeRelativePath(result.relativePath ?? result.path)
      return matchers.some(matcher => matcher.match(rel))
    })
  }

  async ensureIndexed(roots: readonly string[]): Promise<IndexResult> {
    const result: IndexResult = {
      filesIndexed: 0,
      filesSkipped: 0,
      errors: [],
    }

    const errors: string[] = []
    let filesIndexed = 0
    let filesSkipped = 0

    // Get already-indexed roots
    const watchedRoots = new Map<string, WatchedRoot>()
    for (const wr of getWatchedRoots(this.db)) {
      watchedRoots.set(wr.root, wr)
    }

    // Expand all roots for symlink checking
    const expandedRoots = roots.map(expandTilde)

    for (const root of roots) {
      const expandedRoot = expandTilde(root)

      // Check if already indexed
      const existing = watchedRoots.get(expandedRoot)
      if (existing?.lastIndexed) {
        // Already indexed, skip
        continue
      }

      try {
        const indexOptions: IndexOptions = {
          maxDepth: getDepthForRoot(this.config, expandedRoot),
          includeHidden: this.config.index.include_hidden,
          includeGitignored: !this.config.index.exclude.gitignored_files,
          exclude: [...this.config.index.exclude.patterns],
          incremental: false,
          maxFiles: this.config.index.limits.max_files_per_root,
        }

        const indexResult = await indexDirectory(
          root,
          indexOptions,
          this.db,
          this.dbOps,
          expandedRoots
        )

        filesIndexed += indexResult.filesIndexed
        filesSkipped += indexResult.filesSkipped
        errors.push(...indexResult.errors)

        // Update watched root
        updateWatchedRoot(this.db, {
          root: expandedRoot,
          maxDepth: indexOptions.maxDepth ?? 10,
          lastIndexed: Date.now(),
          fileCount: indexResult.filesIndexed,
        })

        // Build frecency data if this is a git repo
        await this.updateFrecencyForRoot(expandedRoot)
      } catch (err) {
        errors.push(`Failed to index ${root}: ${ensureError(err).message}`)
      }
    }

    return {
      filesIndexed,
      filesSkipped,
      errors,
    }
  }

  async refreshIndex(root: string, options: { force?: boolean } = {}): Promise<RefreshResult> {
    const startTime = performance.now()
    const errors: string[] = []
    let filesIndexed = 0
    const force = options.force === true

    const expandedRoot = expandTilde(root)

    try {
      // Get existing watched root data
      const watchedRoots = getWatchedRoots(this.db)
      const existing = watchedRoots.find(wr => wr.root === expandedRoot)

      const indexOptions: IndexOptions = {
        maxDepth: getDepthForRoot(this.config, expandedRoot),
        includeHidden: this.config.index.include_hidden,
        includeGitignored: !this.config.index.exclude.gitignored_files,
        exclude: [...this.config.index.exclude.patterns],
        incremental: !force,
        maxFiles: this.config.index.limits.max_files_per_root,
        lastIndexed: force ? null : (existing?.lastIndexed ?? null),
      }

      // Get all configured roots for symlink checking
      const allRoots = this.config.index.roots.map(expandTilde)

      const indexResult = await indexDirectory(root, indexOptions, this.db, this.dbOps, allRoots)

      filesIndexed = indexResult.filesIndexed
      errors.push(...indexResult.errors)

      // Update watched root
      updateWatchedRoot(this.db, {
        root: expandedRoot,
        maxDepth: indexOptions.maxDepth ?? 10,
        lastIndexed: Date.now(),
        fileCount: force ? filesIndexed : (existing?.fileCount ?? 0) + filesIndexed,
      })

      // Update frecency data
      await this.updateFrecencyForRoot(expandedRoot)
    } catch (err) {
      errors.push(`Failed to refresh ${root}: ${ensureError(err).message}`)
    }

    return {
      filesIndexed,
      duration: performance.now() - startTime,
      errors,
    }
  }

  /**
   * Updates frecency records for files in a root directory.
   */
  private async updateFrecencyForRoot(root: string): Promise<void> {
    try {
      // Check if this is a git repo
      const inGitRepo = await isGitRepo(root)
      if (!inGitRepo) {
        return
      }

      // Build frecency records from git data
      const frecencyRecords = await buildFrecencyRecords(root, {
        since: '90 days ago',
        maxCommits: 1000,
      })

      if (frecencyRecords.length > 0) {
        // Convert to database format
        const dbRecords: DbFrecencyRecord[] = frecencyRecords.map(r => ({
          path: r.path,
          gitRecency: r.gitRecency,
          gitFrequency: r.gitFrequency,
          gitStatusBoost: r.gitStatusBoost,
          lastSeen: r.lastSeen,
        }))

        upsertFrecency(this.db, dbRecords)
      }
    } catch (err) {
      // Frecency update failures are non-fatal
      debugLog('frecency', 'Failed to update frecency', err)
    }
  }

  async close(): Promise<void> {
    closeDatabase(this.db)
  }
}

function normalizeRelativePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/\/+/g, '/')
}

function buildPatternMatchers(
  patterns: readonly string[]
): Array<{ match: (path: string) => boolean }> {
  const matchers: Array<{ match: (path: string) => boolean }> = []
  for (const pattern of patterns) {
    if (!pattern) continue
    const candidates = pattern.includes('/') ? [pattern] : [pattern, `**/${pattern}`]
    for (const candidate of candidates) {
      try {
        matchers.push(new Bun.Glob(candidate))
      } catch {
        // Ignore invalid patterns
      }
    }
  }
  return matchers
}

function fuzzyScoreTokens(query: string, target: string): number {
  const tokens = query.trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) {
    return -1
  }
  let total = 0
  for (const token of tokens) {
    const score = fuzzyScore(token, target)
    if (score < 0) {
      return -1
    }
    total += score
  }
  return total
}

function fuzzyScore(query: string, target: string): number {
  const needle = query.toLowerCase()
  const hay = target.toLowerCase()
  let score = 0
  let lastIndex = -1
  let streak = 0

  for (let i = 0; i < needle.length; i++) {
    const ch = needle[i]
    if (ch === undefined) {
      continue
    }
    const idx = hay.indexOf(ch, lastIndex + 1)
    if (idx === -1) {
      return -1
    }

    const prev = idx > 0 ? hay[idx - 1] : ''
    const isBoundary =
      prev === '' || prev === '/' || prev === '_' || prev === '-' || prev === ' ' || prev === '.'
    if (idx === lastIndex + 1) {
      streak += 1
    } else {
      streak = 1
    }

    score += 1
    if (isBoundary) {
      score += 3
    }
    score += Math.min(streak, 5)

    lastIndex = idx
  }

  // Prefer shorter paths and earlier matches.
  score += Math.max(0, 20 - hay.length / 10)
  score += Math.max(0, 10 - lastIndex / 10)

  return score
}

// ============================================================================
// Factory Function
// ============================================================================

/**
 * Creates a new file picker instance.
 *
 * The file picker provides fast file search with FTS5 indexing and
 * frecency-based ranking. It supports prefix syntax for filtering
 * by namespace, folder, or extension.
 *
 * @param options - Configuration options
 * @returns A file picker instance
 *
 * @example
 * ```ts
 * const picker = await createFilePicker();
 *
 * // Search for files
 * const results = await picker.search('button component');
 *
 * // Clean up when done
 * await picker.close();
 * ```
 */
export async function createFilePicker(options: FilePickerOptions = {}): Promise<FilePicker> {
  const { dbPath = getDefaultDbPath(), configPath } = options

  // Load configuration
  const config = await loadConfig(configPath)

  // Open database
  const db = openDatabase(dbPath)

  return new FilePickerImpl(db, config)
}

// ============================================================================
// Re-exports
// ============================================================================

// Re-export shared types from canonical location
export type { FileMeta, FrecencyRecord, WatchedRoot, SearchResult, SearchOptions } from './types'

// Re-export types that consumers might need
export type { Config, WeightsConfig, NamespacesConfig, PrioritiesConfig } from './config'

export type { RankedResult } from './frecency'

export type { Prefix, ParseResult, ResolveResult } from './prefix'
