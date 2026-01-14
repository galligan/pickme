/**
 * File indexer for the pickme file picker.
 *
 * Scans configured directories using fd (fast) or fs.readdir (fallback),
 * handles symlinks safely, and populates the FTS5 database in batches.
 *
 * @module indexer
 */

import { $ } from 'bun'
import type { Database } from 'bun:sqlite'
import type { Dirent } from 'node:fs'
import { lstat, readdir, realpath as fsRealpath, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import type { Config } from './config'
import { getDepthForRoot } from './config'
import type { FileMeta, WatchedRoot } from './types'
import { expandTilde } from './utils'

// Re-export types for backwards compatibility
export type { FileMeta, WatchedRoot } from './types'
export type { Database } from 'bun:sqlite'

/**
 * Options for indexDirectory().
 */
export interface IndexOptions {
  /** Max directory depth to traverse. Default: 10 */
  maxDepth?: number
  /** Include hidden files/directories (dotfiles). Default: false */
  includeHidden?: boolean
  /** Include files ignored by VCS ignore files (gitignore). Default: false */
  includeGitignored?: boolean
  /** Glob patterns to exclude (e.g., "node_modules", ".git"). Default: [] */
  exclude?: readonly string[]
  /** Specific directories to skip entirely (absolute paths). Default: [] */
  disabled?: readonly string[]
  /** Only update files changed since last index. Default: false */
  incremental?: boolean
  /** Limit total files indexed. Default: unlimited */
  maxFiles?: number
  /** Last indexed timestamp for incremental mode (unix epoch ms) */
  lastIndexed?: number | null
}

/**
 * Result of indexing a directory.
 */
export interface IndexResult {
  /** Number of files successfully indexed */
  filesIndexed: number
  /** Number of files skipped (symlinks outside roots, broken, etc.) */
  filesSkipped: number
  /** Error messages for files that failed to index */
  errors: string[]
}

/**
 * Result of refreshing all configured roots.
 */
export interface RefreshResult {
  /** Number of roots processed */
  rootsProcessed: number
  /** Total files indexed across all roots */
  totalFilesIndexed: number
  /** Total files skipped across all roots */
  totalFilesSkipped: number
  /** Time taken in milliseconds */
  duration: number
  /** Error messages from all roots */
  errors: string[]
}

/**
 * Options for findRecentFiles().
 */
export interface RecentFilesOptions {
  /** Glob patterns to exclude */
  exclude?: readonly string[]
  /** Max results to return. Default: 100 */
  maxResults?: number
}

/**
 * Database operations interface.
 * Allows dependency injection for testing.
 * Uses `unknown` for db parameter since actual type safety is handled by callbacks.
 */
export interface DbOperations {
  upsertFiles(db: unknown, files: FileMeta[]): void
  deleteFiles(db: unknown, paths: string[]): void
  updateWatchedRoot(db: unknown, root: WatchedRoot): void
  getWatchedRoots(db: unknown): WatchedRoot[]
  getFilesForRoot(db: unknown, root: string): string[]
}

// ============================================================================
// Constants
// ============================================================================

/** Number of files to insert per database batch */
const BATCH_SIZE = 100

/** Cache for fd availability check */
let fdAvailable: boolean | null = null

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Checks if fd (fast file finder) is available on the system.
 * Result is cached after first call.
 */
export async function hasFd(): Promise<boolean> {
  if (fdAvailable !== null) {
    return fdAvailable
  }

  try {
    const result = await $`which fd`.quiet().nothrow()
    fdAvailable = result.exitCode === 0
  } catch {
    fdAvailable = false
  }

  return fdAvailable
}

/**
 * Resets the fd availability cache.
 * Useful for testing.
 */
export function resetFdCache(): void {
  fdAvailable = null
}

/**
 * Builds FileMeta from an absolute path and its root directory.
 *
 * @param absolutePath - Full path to the file
 * @param root - The root directory this file belongs to
 * @param mtime - File modification time in milliseconds
 * @returns FileMeta object ready for database insertion
 */
export function buildFileMeta(absolutePath: string, root: string, mtime: number): FileMeta {
  return {
    path: absolutePath,
    filename: basename(absolutePath),
    dirComponents: absolutePath.split(sep).filter(Boolean).join(' '),
    root,
    mtime,
    relativePath: relative(root, absolutePath),
  }
}

/**
 * Checks if a path is within any of the indexed roots.
 *
 * @param targetPath - The path to check
 * @param indexedRoots - Array of indexed root directories
 * @returns true if the path is within at least one root
 */
export function isWithinIndexedRoots(targetPath: string, indexedRoots: readonly string[]): boolean {
  return indexedRoots.some(root => {
    const expandedRoot = expandTilde(root)
    return targetPath === expandedRoot || targetPath.startsWith(expandedRoot + sep)
  })
}

/**
 * Builds fd exclude flags from patterns.
 *
 * @param patterns - Array of exclude patterns
 * @returns Array of fd flags like ["--exclude", "node_modules", "--exclude", ".git"]
 */
function buildFdExcludeFlags(patterns: readonly string[]): string[] {
  const flags: string[] = []
  for (const pattern of patterns) {
    flags.push('--exclude', pattern)
  }
  return flags
}

// ============================================================================
// File Discovery - fd (Fast)
// ============================================================================

/**
 * Discovers files using fd (fast file finder).
 *
 * @param root - Root directory to scan
 * @param options - Index options including depth and exclude patterns
 * @returns Array of absolute file paths
 */
async function discoverFilesWithFd(
  root: string,
  options: IndexOptions
): Promise<{ files: string[]; errors: string[] }> {
  const maxDepth = options.maxDepth ?? 10
  const includeHidden = options.includeHidden ?? false
  const includeGitignored = options.includeGitignored ?? false
  const excludePatterns = options.exclude ?? []
  const disabledDirs = options.disabled ?? []
  const maxFiles = options.maxFiles

  // Check if the root itself is disabled
  for (const disabled of disabledDirs) {
    if (root === disabled || root.startsWith(disabled + sep)) {
      return { files: [], errors: [] }
    }
  }

  // Build exclude flags including disabled directories
  // Convert absolute disabled dirs to relative paths for fd (which expects patterns, not absolute paths)
  const relativeDisabledDirs = disabledDirs
    .filter(dir => dir.startsWith(root + sep))
    .map(dir => dir.slice(root.length + 1))
  const allExcludes = [...excludePatterns, ...relativeDisabledDirs]
  const excludeFlags = buildFdExcludeFlags(allExcludes)

  try {
    // Build fd command
    // fd --type f --follow --max-depth N --exclude patterns... . root
    const args = [
      '--type',
      'f',
      '--follow', // Follow symlinks
      '--max-depth',
      String(maxDepth),
      ...excludeFlags,
    ]

    if (includeHidden) {
      args.push('--hidden')
    }
    if (includeGitignored) {
      args.push('--no-ignore-vcs')
    }

    if (maxFiles !== undefined) {
      args.push('--max-results', String(maxFiles))
    }

    args.push('.', root)

    const result = await $`fd ${args}`.quiet().nothrow()

    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString().trim()
      if (stderr) {
        return { files: [], errors: [`fd error: ${stderr}`] }
      }
      // fd returns non-zero when no files found, which is fine
      return { files: [], errors: [] }
    }

    const output = result.stdout.toString().trim()
    const files = output ? output.split('\n').filter(Boolean) : []

    return { files, errors: [] }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { files: [], errors: [`fd execution failed: ${message}`] }
  }
}

// ============================================================================
// File Discovery - fs.readdir (Fallback)
// ============================================================================

/**
 * Discovers files using Node's fs.readdir (fallback when fd unavailable).
 *
 * @param root - Root directory to scan
 * @param options - Index options including depth and exclude patterns
 * @param indexedRoots - All indexed roots (for symlink scope checking)
 * @returns Array of absolute file paths and any errors encountered
 */
async function discoverFilesWithFs(
  root: string,
  options: IndexOptions,
  indexedRoots: readonly string[]
): Promise<{ files: string[]; errors: string[] }> {
  const maxDepth = options.maxDepth ?? 10
  const includeHidden = options.includeHidden ?? false
  const excludePatterns = options.exclude ?? []
  const disabledDirs = options.disabled ?? []
  const maxFiles = options.maxFiles

  // Check if the root itself is disabled
  for (const disabled of disabledDirs) {
    if (root === disabled || root.startsWith(disabled + sep)) {
      return { files: [], errors: [] }
    }
  }

  const files: string[] = []
  const errors: string[] = []

  // Check if a directory path is disabled
  const isDisabled = (dirPath: string): boolean => {
    for (const disabled of disabledDirs) {
      if (dirPath === disabled || dirPath.startsWith(disabled + sep)) {
        return true
      }
    }
    return false
  }

  // Convert exclude patterns to a simple check function
  // Note: This is a simplified pattern matching, not full glob support
  const shouldExclude = (name: string): boolean => {
    return excludePatterns.some(pattern => {
      // Handle simple patterns (no wildcards)
      if (!pattern.includes('*')) {
        return name === pattern
      }
      // Handle *.ext patterns
      if (pattern.startsWith('*.')) {
        return name.endsWith(pattern.slice(1))
      }
      // Handle other patterns as prefix match
      return name.startsWith(pattern.replace(/\*.*$/, ''))
    })
  }

  /**
   * Recursively scans a directory.
   */
  async function scanDir(dirPath: string, currentDepth: number): Promise<void> {
    if (currentDepth > maxDepth) {
      return
    }

    if (maxFiles !== undefined && files.length >= maxFiles) {
      return
    }

    let entries: Dirent<string>[]
    try {
      // Cast needed due to Bun's readdir returning Dirent<NonSharedBuffer>
      entries = (await readdir(dirPath, { withFileTypes: true })) as Dirent<string>[]
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      errors.push(`Failed to read directory ${dirPath}: ${message}`)
      return
    }

    for (const entry of entries) {
      if (maxFiles !== undefined && files.length >= maxFiles) {
        break
      }

      // Ensure name is a string (Bun compatibility)
      const name = String(entry.name)

      if (!includeHidden && name.startsWith('.')) {
        continue
      }

      // Skip excluded patterns
      if (shouldExclude(name)) {
        continue
      }

      const fullPath = join(dirPath, name)

      try {
        if (entry.isSymbolicLink()) {
          // Handle symlinks
          const resolvedPath = await resolveSymlink(fullPath, indexedRoots)
          if (resolvedPath === null) {
            // Broken or out-of-scope symlink, skip
            continue
          }

          // Check what the symlink points to
          const targetStat = await stat(resolvedPath)
          if (targetStat.isFile()) {
            files.push(resolvedPath)
          } else if (targetStat.isDirectory()) {
            // Skip disabled directories (including symlinked ones)
            if (!isDisabled(resolvedPath)) {
              await scanDir(resolvedPath, currentDepth + 1)
            }
          }
        } else if (entry.isFile()) {
          files.push(fullPath)
        } else if (entry.isDirectory()) {
          // Skip disabled directories
          if (!isDisabled(fullPath)) {
            await scanDir(fullPath, currentDepth + 1)
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        errors.push(`Error processing ${fullPath}: ${message}`)
      }
    }
  }

  // Start at depth 1 to match fd's depth counting
  // (fd counts the starting directory as depth 1, not 0)
  await scanDir(root, 1)

  return { files, errors }
}

/**
 * Resolves a symlink and validates it's within indexed roots.
 *
 * @param symlinkPath - Path to the symlink
 * @param indexedRoots - Array of indexed root directories
 * @returns Resolved path, or null if broken or out of scope
 */
async function resolveSymlink(
  symlinkPath: string,
  indexedRoots: readonly string[]
): Promise<string | null> {
  try {
    const resolvedPath = await fsRealpath(symlinkPath)

    // Check if resolved path is within indexed roots
    if (!isWithinIndexedRoots(resolvedPath, indexedRoots)) {
      // Symlink escapes indexed roots - skip silently
      return null
    }

    return resolvedPath
  } catch {
    // Broken symlink
    return null
  }
}

// ============================================================================
// Core Functions
// ============================================================================

/**
 * Indexes a single directory.
 *
 * Uses fd for fast file discovery when available, falls back to fs.readdir.
 * Handles symlinks safely, respects depth limits, and batches database inserts.
 *
 * @param root - Root directory to index
 * @param options - Index options
 * @param db - Database instance
 * @param dbOps - Database operations (for dependency injection)
 * @param indexedRoots - All indexed roots (for symlink scope checking)
 * @returns IndexResult with counts and errors
 *
 * @example
 * ```ts
 * const result = await indexDirectory('/Users/dev/project', {
 *   maxDepth: 10,
 *   exclude: ['node_modules', '.git'],
 *   incremental: true,
 * }, db, dbOps, config.index.roots)
 * console.log(`Indexed ${result.filesIndexed} files`)
 * ```
 */
export async function indexDirectory(
  root: string,
  options: IndexOptions,
  db: unknown,
  dbOps: DbOperations,
  indexedRoots: readonly string[]
): Promise<IndexResult> {
  const result: IndexResult = {
    filesIndexed: 0,
    filesSkipped: 0,
    errors: [],
  }

  // Expand tilde in root path
  const expandedRoot = expandTilde(root)

  // Discover files using fd or fallback
  const useFd = await hasFd()
  const { files, errors: discoveryErrors } = useFd
    ? await discoverFilesWithFd(expandedRoot, options)
    : await discoverFilesWithFs(expandedRoot, options, indexedRoots)

  result.errors.push(...discoveryErrors)

  // Process files in batches
  const batch: FileMeta[] = []
  const lastIndexed = options.incremental ? (options.lastIndexed ?? 0) : 0

  for (const filePath of files) {
    try {
      // Get file stats
      const fileStat = await lstat(filePath)

      // For incremental mode, skip files not modified since last index
      if (options.incremental && lastIndexed && fileStat.mtimeMs <= lastIndexed) {
        result.filesSkipped++
        continue
      }

      // Handle symlinks - resolve to canonical path
      let canonicalPath = filePath
      if (fileStat.isSymbolicLink()) {
        const resolved = await resolveSymlink(filePath, indexedRoots)
        if (resolved === null) {
          result.filesSkipped++
          continue
        }
        canonicalPath = resolved
      }

      // Build file metadata
      const meta = buildFileMeta(canonicalPath, expandedRoot, fileStat.mtimeMs)
      batch.push(meta)

      // Flush batch when full
      if (batch.length >= BATCH_SIZE) {
        dbOps.upsertFiles(db, batch)
        result.filesIndexed += batch.length
        batch.length = 0
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.errors.push(`Error indexing ${filePath}: ${message}`)
      result.filesSkipped++
    }
  }

  // Flush remaining files
  if (batch.length > 0) {
    dbOps.upsertFiles(db, batch)
    result.filesIndexed += batch.length
  }

  return result
}

/**
 * Refreshes the index for all configured roots.
 *
 * Runs incremental updates when possible, tracking which files need
 * re-indexing based on mtime changes.
 *
 * @param db - Database instance
 * @param config - Configuration with index roots
 * @param dbOps - Database operations (for dependency injection)
 * @returns RefreshResult with aggregate stats
 *
 * @example
 * ```ts
 * const result = await refreshIndex(db, config, dbOps)
 * console.log(`Refreshed ${result.rootsProcessed} roots in ${result.duration}ms`)
 * ```
 */
export async function refreshIndex(
  db: Database,
  config: Config,
  dbOps: DbOperations
): Promise<RefreshResult> {
  const startTime = performance.now()

  const result: RefreshResult = {
    rootsProcessed: 0,
    totalFilesIndexed: 0,
    totalFilesSkipped: 0,
    duration: 0,
    errors: [],
  }

  // Get existing watched roots for incremental mode
  const watchedRoots = new Map<string, WatchedRoot>()
  try {
    for (const wr of dbOps.getWatchedRoots(db)) {
      watchedRoots.set(wr.root, wr)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    result.errors.push(`Failed to get watched roots: ${message}`)
  }

  // Expand all root paths for symlink validation
  const expandedRoots = config.index.roots.map(expandTilde)

  // Index each configured root
  for (const root of config.index.roots) {
    const expandedRoot = expandTilde(root)
    const existingRoot = watchedRoots.get(expandedRoot)

    const options: IndexOptions = {
      maxDepth: getDepthForRoot(config, expandedRoot),
      includeHidden: config.index.include_hidden,
      includeGitignored: !config.index.exclude.gitignored_files,
      exclude: config.index.exclude.patterns,
      disabled: config.index.disabled,
      incremental: existingRoot?.lastIndexed !== null,
      maxFiles: config.index.limits.max_files_per_root,
      lastIndexed: existingRoot?.lastIndexed ?? null,
    }

    try {
      const indexResult = await indexDirectory(root, options, db, dbOps, expandedRoots)

      result.totalFilesIndexed += indexResult.filesIndexed
      result.totalFilesSkipped += indexResult.filesSkipped
      result.errors.push(...indexResult.errors)
      result.rootsProcessed++

      // Update watched root metadata
      dbOps.updateWatchedRoot(db, {
        root: expandedRoot,
        maxDepth: options.maxDepth ?? 10,
        lastIndexed: Date.now(),
        fileCount:
          (existingRoot?.fileCount ?? 0) +
          indexResult.filesIndexed -
          (options.incremental ? 0 : (existingRoot?.fileCount ?? 0)),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      result.errors.push(`Failed to index root ${root}: ${message}`)
    }
  }

  result.duration = performance.now() - startTime

  return result
}

/**
 * Prunes files that no longer exist from the index.
 *
 * Checks each indexed file for the given root and removes entries
 * for files that have been deleted from disk.
 *
 * @param db - Database instance
 * @param root - Root directory to prune
 * @param dbOps - Database operations (for dependency injection)
 * @returns Number of files pruned
 *
 * @example
 * ```ts
 * const pruned = await pruneDeletedFiles(db, '/Users/dev/project', dbOps)
 * console.log(`Removed ${pruned} stale entries`)
 * ```
 */
export async function pruneDeletedFiles(
  db: Database,
  root: string,
  dbOps: DbOperations
): Promise<number> {
  const expandedRoot = expandTilde(root)

  // Get all files indexed for this root
  const indexedPaths = dbOps.getFilesForRoot(db, expandedRoot)

  // Check which files no longer exist
  const deletedPaths: string[] = []

  for (const filePath of indexedPaths) {
    try {
      await stat(filePath)
      // File exists, keep it
    } catch {
      // File doesn't exist or is inaccessible
      deletedPaths.push(filePath)
    }
  }

  // Delete stale entries in batch
  if (deletedPaths.length > 0) {
    dbOps.deleteFiles(db, deletedPaths)
  }

  return deletedPaths.length
}

/**
 * Finds files created or modified recently that may not yet be indexed.
 *
 * Uses `fd --changed-within` for fast discovery of recent files.
 * Falls back to checking all files' mtimes when fd is unavailable.
 *
 * @param projectRoot - Project root directory to search
 * @param within - Time window (e.g., "24h", "1d", "30m")
 * @param options - Additional options
 * @returns Array of absolute file paths
 *
 * @example
 * ```ts
 * const recentFiles = await findRecentFiles(
 *   '/Users/dev/project',
 *   '24h',
 *   { exclude: ['node_modules'], maxResults: 50 }
 * )
 * ```
 */
export async function findRecentFiles(
  projectRoot: string,
  within: string,
  options?: RecentFilesOptions
): Promise<string[]> {
  const expandedRoot = expandTilde(projectRoot)
  const excludePatterns = options?.exclude ?? []
  const maxResults = options?.maxResults ?? 100

  const useFd = await hasFd()

  if (useFd) {
    return findRecentFilesWithFd(expandedRoot, within, excludePatterns, maxResults)
  }

  return findRecentFilesWithFs(expandedRoot, within, excludePatterns, maxResults)
}

/**
 * Finds recent files using fd --changed-within.
 */
async function findRecentFilesWithFd(
  root: string,
  within: string,
  excludePatterns: readonly string[],
  maxResults: number
): Promise<string[]> {
  const excludeFlags = buildFdExcludeFlags(excludePatterns)

  try {
    const args = [
      '--type',
      'f',
      '--follow',
      '--changed-within',
      within,
      '--max-results',
      String(maxResults),
      ...excludeFlags,
      '.',
      root,
    ]

    const result = await $`fd ${args}`.quiet().nothrow()

    if (result.exitCode !== 0) {
      return []
    }

    const output = result.stdout.toString().trim()
    return output ? output.split('\n').filter(Boolean) : []
  } catch {
    return []
  }
}

/**
 * Finds recent files using fs.readdir and mtime checks.
 * This is slower than fd but works as a fallback.
 */
async function findRecentFilesWithFs(
  root: string,
  within: string,
  excludePatterns: readonly string[],
  maxResults: number
): Promise<string[]> {
  // Parse the "within" time string to milliseconds
  const cutoffMs = Date.now() - parseTimeString(within)

  const files: string[] = []

  const shouldExclude = (name: string): boolean => {
    return excludePatterns.some(pattern => {
      if (!pattern.includes('*')) {
        return name === pattern
      }
      if (pattern.startsWith('*.')) {
        return name.endsWith(pattern.slice(1))
      }
      return name.startsWith(pattern.replace(/\*.*$/, ''))
    })
  }

  async function scanDir(dirPath: string): Promise<void> {
    if (files.length >= maxResults) {
      return
    }

    let entries: Dirent<string>[]
    try {
      // Cast needed due to Bun's readdir returning Dirent<NonSharedBuffer>
      entries = (await readdir(dirPath, { withFileTypes: true })) as Dirent<string>[]
    } catch {
      return
    }

    for (const entry of entries) {
      if (files.length >= maxResults) {
        break
      }

      // Ensure name is a string (Bun compatibility)
      const name = String(entry.name)

      if (shouldExclude(name)) {
        continue
      }

      const fullPath = join(dirPath, name)

      try {
        if (entry.isFile()) {
          const fileStat = await stat(fullPath)
          if (fileStat.mtimeMs >= cutoffMs) {
            files.push(fullPath)
          }
        } else if (entry.isDirectory()) {
          await scanDir(fullPath)
        }
      } catch {
        // Skip files we can't stat
      }
    }
  }

  await scanDir(root)

  return files
}

/**
 * Parses a time string like "24h", "1d", "30m" to milliseconds.
 *
 * @param timeStr - Time string with unit suffix
 * @returns Duration in milliseconds
 */
function parseTimeString(timeStr: string): number {
  const match = timeStr.match(/^(\d+)(m|h|d|w)$/)
  if (!match) {
    // Default to 24 hours if unparseable
    return 24 * 60 * 60 * 1000
  }

  const value = parseInt(match[1]!, 10)
  const unit = match[2]!

  switch (unit) {
    case 'm':
      return value * 60 * 1000
    case 'h':
      return value * 60 * 60 * 1000
    case 'd':
      return value * 24 * 60 * 60 * 1000
    case 'w':
      return value * 7 * 24 * 60 * 60 * 1000
    default:
      return 24 * 60 * 60 * 1000
  }
}

// ============================================================================
// CLI Entry Point
// ============================================================================

/**
 * CLI entry point for background refresh operations.
 *
 * Usage: bun run src/indexer.ts --refresh <root>
 *
 * Environment variables:
 * - PICKME_CONFIG_PATH: Custom config file path
 * - PICKME_DB_PATH: Custom database path
 */
if (import.meta.main) {
  const args = process.argv.slice(2)

  if (args[0] === '--refresh' && args[1]) {
    const root = args[1]

    // Dynamic imports to avoid circular dependencies
    const { loadConfig, getDepthForRoot } = await import('./config')
    const {
      openDatabase,
      closeDatabase,
      upsertFiles,
      updateWatchedRoot,
      deleteFiles,
      getWatchedRoots,
    } = await import('./db')
    const { Database } = await import('bun:sqlite')

    try {
      // Load config (respects PICKME_CONFIG_PATH env var)
      const configPath = process.env.PICKME_CONFIG_PATH
      const config = await loadConfig(configPath)

      // Open database (respects PICKME_DB_PATH env var)
      const dbPath = process.env.PICKME_DB_PATH
      const db = openDatabase(dbPath)

      try {
        // Create db operations adapter for indexDirectory
        // Callbacks assert db type since DbOperations uses unknown for flexibility
        const dbOps: DbOperations = {
          upsertFiles: (d, files) => upsertFiles(d as InstanceType<typeof Database>, files),
          deleteFiles: (d, paths) => deleteFiles(d as InstanceType<typeof Database>, paths),
          updateWatchedRoot: (d, r) => updateWatchedRoot(d as InstanceType<typeof Database>, r),
          getWatchedRoots: d => getWatchedRoots(d as InstanceType<typeof Database>),
          getFilesForRoot: () => [], // Not used by indexDirectory
        }

        const expandedRoot = expandTilde(root)
        const maxDepth = getDepthForRoot(config, expandedRoot)

        const result = await indexDirectory(
          expandedRoot,
          {
            maxDepth,
            exclude: config.index.exclude.patterns,
            disabled: config.index.disabled,
          },
          db,
          dbOps,
          config.index.roots.map(expandTilde)
        )

        // Update watched root metadata
        updateWatchedRoot(db, {
          root: expandedRoot,
          maxDepth,
          lastIndexed: Date.now(),
          fileCount: result.filesIndexed,
        })

        console.log(
          `[pickme] Refreshed ${expandedRoot}: ${result.filesIndexed} files indexed, ${result.filesSkipped} skipped`
        )

        if (result.errors.length > 0) {
          console.warn(`[pickme] ${result.errors.length} errors during indexing`)
        }
      } finally {
        closeDatabase(db)
      }
    } catch (err) {
      console.error(
        `[pickme] Refresh failed for ${root}:`,
        err instanceof Error ? err.message : String(err)
      )
      process.exit(1)
    }
  } else if (args[0] === '--help' || args.length === 0) {
    console.log(`
Usage: bun run src/indexer.ts --refresh <root>

Refresh the file index for a single root directory.

Options:
  --refresh <root>  Root directory to index
  --help            Show this help message

Environment variables:
  PICKME_CONFIG_PATH  Custom config file path
  PICKME_DB_PATH      Custom database path
`)
  } else {
    console.error(`Unknown command: ${args.join(' ')}`)
    console.error('Run with --help for usage information')
    process.exit(1)
  }
}
