/**
 * Git utilities for the Claude Code file picker.
 *
 * Provides git repository detection, status parsing for active file boosts,
 * and commit history analysis for frecency scoring.
 *
 * @module git
 */

import { $ } from 'bun'
import * as path from 'node:path'

/** Git recency data for a single file */
export interface GitRecencyData {
  /** Unix timestamp of the most recent commit touching this file */
  lastCommit: number
  /** Number of commits touching this file within the time window */
  frequency: number
}

/** Options for getGitRecency */
export interface GitRecencyOptions {
  /** How far back to look (default: "90 days ago") */
  since?: string
  /** Maximum number of commits to parse (default: 1000) */
  maxCommits?: number
}

/**
 * Check if a directory is inside a git repository.
 *
 * @param dir - Directory path to check
 * @returns True if the directory is inside a git repo, false otherwise
 *
 * @example
 * ```ts
 * const inRepo = await isGitRepo("/path/to/project");
 * if (inRepo) {
 *   // safe to use git commands
 * }
 * ```
 */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const result = await $`git -C ${dir} rev-parse --is-inside-work-tree`.quiet().nothrow()
    return result.exitCode === 0 && result.stdout.toString().trim() === 'true'
  } catch {
    // Git not installed or other error
    return false
  }
}

/**
 * Get boost values for files appearing in git status.
 *
 * Files that are modified, staged, or untracked represent active work
 * and should be prioritized in search results.
 *
 * Uses `-z` flag for NUL-separated output to handle filenames with spaces
 * and renamed files correctly.
 *
 * @param projectRoot - Root directory of the git repository
 * @returns Map of absolute file paths to their boost values
 *          - Modified/staged files: 5.0
 *          - Untracked files: 3.0
 *
 * @example
 * ```ts
 * const boosts = await getGitStatusBoosts("/path/to/project");
 * // boosts.get("/path/to/project/src/index.ts") -> 5.0 (if modified)
 * ```
 */
export async function getGitStatusBoosts(projectRoot: string): Promise<Map<string, number>> {
  const boosts = new Map<string, number>()

  try {
    // Use -z for NUL-separated output (handles spaces, renames)
    const result = await $`git -C ${projectRoot} status --porcelain -z`.quiet().nothrow()

    if (result.exitCode !== 0) {
      return boosts
    }

    const output = result.stdout.toString()
    if (!output) {
      return boosts
    }

    // Split on NUL, filter empty entries
    const entries = output.split('\0').filter(Boolean)

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      if (!entry || entry.length < 3) continue

      const flags = entry.slice(0, 2)
      let file = entry.slice(3)

      // Handle renames: "R  old\0new" - the new name follows
      if (flags.startsWith('R') || flags.startsWith('C')) {
        // For renames/copies, the entry format is "R  old" followed by "new"
        // We want to boost the new (destination) file
        const nextEntry = entries[i + 1]
        if (nextEntry && !nextEntry.match(/^[ MADRCU?!]{2} /)) {
          // Next entry is the destination filename (no status prefix)
          file = nextEntry
          i++ // Skip the next entry since we consumed it
        }
      }

      const fullPath = path.join(projectRoot, file)

      // Modified/staged files get full boost (5.0), untracked slightly less (3.0)
      const boost = flags.includes('?') ? 3.0 : 5.0
      boosts.set(fullPath, boost)
    }
  } catch {
    // Git not available or other error - return empty map
  }

  return boosts
}

/**
 * Parse git log to extract file commit history for frecency scoring.
 *
 * Analyzes recent commits to determine which files are frequently worked on
 * and when they were last modified.
 *
 * @param projectRoot - Root directory of the git repository
 * @param options - Configuration options
 * @returns Map of absolute file paths to their recency data
 *
 * @example
 * ```ts
 * const recency = await getGitRecency("/path/to/project", {
 *   since: "30 days ago",
 *   maxCommits: 500
 * });
 * const data = recency.get("/path/to/project/src/index.ts");
 * // data?.lastCommit -> 1704067200 (Unix timestamp)
 * // data?.frequency -> 15 (number of commits)
 * ```
 */
export async function getGitRecency(
  projectRoot: string,
  options: GitRecencyOptions = {}
): Promise<Map<string, GitRecencyData>> {
  const { since = '90 days ago', maxCommits = 1000 } = options
  const recencyMap = new Map<string, GitRecencyData>()

  try {
    // Use --format to get commit timestamp, followed by file list
    // With -z: entries are NUL-separated, format is:
    //   timestamp\0\nfile1\0file2\0...fileN\0timestamp2\0\n...
    // We parse by iterating through NUL-separated entries and detecting timestamps
    const result =
      await $`git -C ${projectRoot} log --name-only --format=%at -z --since=${since} -n ${maxCommits}`
        .quiet()
        .nothrow()

    if (result.exitCode !== 0) {
      return recencyMap
    }

    const output = result.stdout.toString()
    if (!output) {
      return recencyMap
    }

    // Split on NUL to get all entries (timestamps and filenames mixed)
    const entries = output.split('\0')

    let currentTimestamp: number | null = null

    for (const entry of entries) {
      // Skip empty entries
      const trimmed = entry.trim()
      if (!trimmed) continue

      // Check if this entry is a Unix timestamp (10 digits, all numeric)
      // Timestamps from git are in seconds, so they're 10-digit numbers
      if (/^\d{10}$/.test(trimmed)) {
        const ts = parseInt(trimmed, 10)
        if (!isNaN(ts)) {
          currentTimestamp = ts
          continue
        }
      }

      // This is a filename - skip if we haven't seen a timestamp yet
      if (currentTimestamp === null) continue

      // Skip entries that look like timestamps (shouldn't happen but safety check)
      if (/^\d+$/.test(trimmed)) continue

      const fullPath = path.join(projectRoot, trimmed)
      const existing = recencyMap.get(fullPath)

      if (existing) {
        // Update frequency count
        // Keep the most recent commit timestamp (first encountered = most recent)
        recencyMap.set(fullPath, {
          lastCommit: existing.lastCommit,
          frequency: existing.frequency + 1,
        })
      } else {
        recencyMap.set(fullPath, {
          lastCommit: currentTimestamp,
          frequency: 1,
        })
      }
    }
  } catch {
    // Git not available or other error - return empty map
  }

  return recencyMap
}

/**
 * Calculate a recency score using exponential decay.
 *
 * Uses a 14-day half-life, meaning a file committed 14 days ago
 * gets a score of 0.5, 28 days ago gets 0.25, etc.
 *
 * @param lastCommitTime - Unix timestamp (seconds) of the last commit
 * @returns Score between 0 and 1, where 1 is "just now" and approaches 0 for old commits
 *
 * @example
 * ```ts
 * const now = Date.now() / 1000;
 * gitRecencyScore(now);           // ~1.0 (just committed)
 * gitRecencyScore(now - 14*86400); // ~0.5 (14 days ago)
 * gitRecencyScore(now - 28*86400); // ~0.25 (28 days ago)
 * ```
 */
export function gitRecencyScore(lastCommitTime: number): number {
  const now = Date.now()
  // lastCommitTime is in seconds (Unix timestamp), convert to ms
  const lastCommitMs = lastCommitTime * 1000
  const ageMs = now - lastCommitMs

  // Convert to days
  const daysSince = ageMs / (1000 * 60 * 60 * 24)

  // Exponential decay with 14-day half-life
  // score = e^(-daysSince / 14)
  // At 0 days: e^0 = 1.0
  // At 14 days: e^-1 = 0.368
  // At 28 days: e^-2 = 0.135
  return Math.exp(-daysSince / 14)
}
