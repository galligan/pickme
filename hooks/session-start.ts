#!/usr/bin/env bun
/**
 * Session-start hook for the pickme file picker.
 *
 * Triggers background index refresh on new sessions. This hook:
 * - Completes quickly (< 100ms) to avoid blocking session start
 * - Checks for stale indexes (> 1 hour since last indexed)
 * - Spawns background processes to refresh stale indexes
 * - Refreshes git frecency data for the current project root
 * - Never fails the session start (catches all errors)
 *
 * @module session-start
 */

import { spawn } from 'bun'
import { join } from 'node:path'
import { loadConfig } from '../src/config'
import {
  closeDatabase,
  getWatchedRoots,
  openDatabase,
  updateWatchedRoot,
  upsertFrecency,
} from '../src/db'
import { buildFrecencyRecords } from '../src/frecency'
import { debugLog, expandTilde, getConfigDir, getDataDir } from '../src/utils'

// ============================================================================
// Constants
// ============================================================================

/**
 * Staleness threshold in milliseconds.
 * Indexes older than this are considered stale and need refresh.
 * Default: 1 hour
 */
export const STALE_THRESHOLD_MS = 60 * 60 * 1000

// ============================================================================
// Types
// ============================================================================

/**
 * Context for hook execution.
 * Allows dependency injection for testing.
 */
export interface HookContext {
  /** Current working directory */
  cwd: string
  /** Environment variables */
  env: Record<string, string | undefined>
  /** Optional config path override (for testing) */
  configPath?: string
  /** Optional database path override (for testing) */
  dbPath?: string
}

/**
 * Result of running the session-start hook.
 */
export interface HookResult {
  /** Whether the hook completed successfully */
  success: boolean
  /** Error message if any (logged but not thrown) */
  error?: string
  /** Roots identified as stale */
  staleRoots?: string[]
  /** Project root determined from context */
  projectRoot?: string
  /** Whether git frecency was refreshed */
  gitFrecencyRefreshed?: boolean
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Checks if an index is stale based on last indexed timestamp.
 *
 * @param lastIndexed - Unix timestamp (ms) of last index, or null if never indexed
 * @returns true if the index is stale and needs refresh
 */
export function checkStaleness(lastIndexed: number | null): boolean {
  if (lastIndexed === null) {
    return true
  }

  const now = Date.now()
  const age = now - lastIndexed
  return age > STALE_THRESHOLD_MS
}

/**
 * Determines the project root from context.
 *
 * Priority:
 * 1. CLAUDE_PROJECT_ROOT environment variable
 * 2. Current working directory
 *
 * @param ctx - Hook context with environment and cwd
 * @returns Absolute path to project root
 */
export function determineProjectRoot(ctx: HookContext): string {
  const envRoot = ctx.env.CLAUDE_PROJECT_ROOT
  if (envRoot) {
    return expandTilde(envRoot)
  }
  return ctx.cwd
}

// ============================================================================
// Background Worker
// ============================================================================

/**
 * Spawns a background process to refresh an index.
 *
 * Invokes the indexer CLI in a detached process so it continues
 * after the hook exits. Uses environment variables to pass custom
 * config and database paths.
 *
 * @param root - Root directory to refresh
 * @param configPath - Path to config file
 * @param dbPath - Path to database file
 */
function spawnBackgroundRefresh(root: string, configPath: string, dbPath: string): void {
  try {
    const indexerPath = join(__dirname, '../src/indexer.ts')

    spawn({
      cmd: ['bun', 'run', indexerPath, '--refresh', root],
      env: {
        ...process.env,
        PICKME_CONFIG_PATH: configPath,
        PICKME_DB_PATH: dbPath,
      },
      stdio: ['ignore', 'ignore', 'ignore'],
    })
  } catch (err) {
    // Ignore spawn errors - background refresh is best-effort
    debugLog('hook', 'Failed to spawn background refresh', err)
  }
}

// ============================================================================
// Main Hook Logic
// ============================================================================

/**
 * Runs the session-start hook.
 *
 * This function:
 * 1. Loads configuration
 * 2. Opens database and checks for stale indexes
 * 3. Schedules background refresh for stale indexes
 * 4. Refreshes git frecency data for the current project
 *
 * The function is designed to complete quickly (< 100ms) and never throw.
 *
 * @param ctx - Hook context
 * @returns Hook result with status and identified stale roots
 */
export async function runSessionStartHook(ctx: HookContext): Promise<HookResult> {
  const result: HookResult = {
    success: true,
    staleRoots: [],
  }

  try {
    // Determine paths (uses XDG Base Directory Specification)
    const configPath = ctx.configPath ?? join(getConfigDir(), 'config.toml')
    const dbPath = ctx.dbPath ?? join(getDataDir(), 'index.db')

    // Determine project root
    result.projectRoot = determineProjectRoot(ctx)

    // Load configuration (fast - just file read and parse)
    const config = await loadConfig(configPath)

    // Open database
    let db
    try {
      db = openDatabase(dbPath)
    } catch (err) {
      // Database errors are logged but don't fail the hook
      result.error = `Database error: ${err instanceof Error ? err.message : String(err)}`
      console.error(`[pickme] ${result.error}`)
      return result
    }

    try {
      // Get watched roots to check staleness
      const watchedRoots = getWatchedRoots(db)
      const watchedRootsMap = new Map(watchedRoots.map(wr => [wr.root, wr]))

      // Check each configured root for staleness
      const staleRoots: string[] = []
      for (const root of config.index.roots) {
        const expandedRoot = expandTilde(root)
        const watched = watchedRootsMap.get(expandedRoot)
        const lastIndexed = watched?.lastIndexed ?? null

        if (checkStaleness(lastIndexed)) {
          staleRoots.push(expandedRoot)
        }
      }

      result.staleRoots = staleRoots

      // Schedule background refresh for stale roots (non-blocking)
      if (staleRoots.length > 0) {
        for (const root of staleRoots) {
          // Mark as refreshing to prevent re-scheduling on consecutive session starts
          // The background process will update fileCount when it completes
          const existing = watchedRootsMap.get(root)
          updateWatchedRoot(db, {
            root,
            maxDepth: existing?.maxDepth ?? 10,
            lastIndexed: Date.now(),
            fileCount: existing?.fileCount ?? null,
          })

          // Spawn background refresh process
          spawnBackgroundRefresh(root, configPath, dbPath)
        }
      }

      // Refresh git frecency for current project (if in a configured root)
      if (result.projectRoot) {
        const isConfiguredRoot = config.index.roots.some(r => {
          const expanded = expandTilde(r)
          return result.projectRoot === expanded || result.projectRoot?.startsWith(expanded + '/')
        })

        if (isConfiguredRoot) {
          try {
            const frecencyRecords = await buildFrecencyRecords(result.projectRoot, {
              since: '30 days ago',
              maxCommits: 500,
            })

            if (frecencyRecords.length > 0) {
              // Convert to the format expected by upsertFrecency
              const dbRecords = frecencyRecords.map(r => ({
                path: r.path,
                gitRecency: r.gitRecency,
                gitFrequency: r.gitFrequency,
                gitStatusBoost: r.gitStatusBoost,
                lastSeen: r.lastSeen,
              }))

              upsertFrecency(db, dbRecords)
              result.gitFrecencyRefreshed = true
            }
          } catch (err) {
            // Git frecency errors are logged but don't fail the hook
            console.error(
              `[pickme] Git frecency error: ${err instanceof Error ? err.message : String(err)}`
            )
          }
        }
      }
    } finally {
      closeDatabase(db)
    }
  } catch (err) {
    // Catch-all for any unexpected errors
    result.error = `Hook error: ${err instanceof Error ? err.message : String(err)}`
    console.error(`[pickme] ${result.error}`)
    // Still return success=true - we never want to fail the session start
  }

  return result
}

// ============================================================================
// Main Entry Point
// ============================================================================

/**
 * Main entry point when executed as a script.
 * Reads context from environment and cwd, runs the hook, and exits.
 */
async function main(): Promise<void> {
  try {
    const ctx: HookContext = {
      cwd: process.cwd(),
      env: process.env as Record<string, string | undefined>,
      configPath: process.env.PICKME_CONFIG_PATH,
      dbPath: process.env.PICKME_DB_PATH,
    }

    const result = await runSessionStartHook(ctx)

    if (result.staleRoots && result.staleRoots.length > 0) {
      console.log(`[pickme] Index refresh scheduled for ${result.staleRoots.length} root(s)`)
    }

    if (result.gitFrecencyRefreshed) {
      console.log('[pickme] Git frecency data refreshed')
    }
  } catch (error) {
    // Log but don't fail
    console.error('[pickme] Hook error:', error)
  }

  // Always exit 0 - never fail session start
  process.exit(0)
}

// Run main if executed directly
if (import.meta.main) {
  main()
}
