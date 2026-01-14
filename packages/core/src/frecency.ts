/**
 * Frecency scoring module for the Claude Code file picker.
 *
 * Combines recency and frequency signals from git history with current git status
 * to rank search results by relevance to the developer's active work.
 *
 * @module frecency
 */

import {
  getGitRecency,
  getGitStatusBoosts,
  gitRecencyScore,
  isGitRepo,
  type GitRecencyData,
} from './git'
import type { WeightsConfig } from './config'
import type { FrecencyRecord, SearchResult } from './types'

// Re-export types for backwards compatibility
export type { FrecencyRecord, SearchResult } from './types'

/**
 * Options for building frecency records from git history.
 */
export interface BuildFrecencyOptions {
  /** How far back to look in git history (default: "90 days ago") */
  readonly since?: string
  /** Maximum number of commits to parse (default: 1000) */
  readonly maxCommits?: number
}

/**
 * A search result with frecency scoring applied.
 */
export interface RankedResult extends SearchResult {
  /** Score from frecency calculation */
  readonly frecencyScore: number
  /** Combined final score for ranking */
  readonly finalScore: number
}

// ============================================================================
// Score Calculation
// ============================================================================

/**
 * Calculate frecency score for a single file.
 *
 * Applies weighted combination of:
 * - Git recency (exponential decay based on last commit)
 * - Git frequency (number of commits touching the file)
 * - Git status boost (extra weight for modified/staged/untracked files)
 *
 * @param frecency - Frecency data for the file
 * @param weights - Weight multipliers from configuration
 * @returns Combined frecency score
 *
 * @example
 * ```ts
 * const record = { gitRecency: 0.5, gitFrequency: 10, gitStatusBoost: 5.0, ... }
 * const weights = { git_recency: 1.0, git_frequency: 0.5, git_status: 5.0 }
 * const score = calculateScore(record, weights)
 * // score = 0.5 * 1.0 + 10 * 0.5 + 5.0 * 5.0 = 30.5
 * ```
 */
export function calculateScore(frecency: FrecencyRecord, weights: WeightsConfig): number {
  return (
    frecency.gitRecency * weights.git_recency +
    frecency.gitFrequency * weights.git_frequency +
    frecency.gitStatusBoost * weights.git_status
  )
}

// ============================================================================
// Building Frecency Records
// ============================================================================

/**
 * Build frecency records from git data for a project.
 *
 * Combines:
 * 1. Git recency data (last commit timestamp, commit count)
 * 2. Git status boosts (modified, staged, untracked files)
 *
 * Returns empty array if:
 * - Directory is not a git repository
 * - Git is not available
 * - Git commands fail
 *
 * @param projectRoot - Root directory of the project
 * @param options - Configuration for git history lookup
 * @returns Array of frecency records for all files with git activity
 *
 * @example
 * ```ts
 * const records = await buildFrecencyRecords('/path/to/project', {
 *   since: '30 days ago',
 *   maxCommits: 500
 * })
 * // Creates a Map for fast lookup
 * const frecencyMap = new Map(records.map(r => [r.path, r]))
 * ```
 */
export async function buildFrecencyRecords(
  projectRoot: string,
  options: BuildFrecencyOptions = {}
): Promise<FrecencyRecord[]> {
  // Check if this is a git repository
  const inGitRepo = await isGitRepo(projectRoot)
  if (!inGitRepo) {
    return []
  }

  const { since = '90 days ago', maxCommits = 1000 } = options

  // Fetch git data in parallel
  const [recencyData, statusBoosts] = await Promise.all([
    getGitRecency(projectRoot, { since, maxCommits }),
    getGitStatusBoosts(projectRoot),
  ])

  // Collect all unique file paths from both sources
  const allPaths = new Set<string>([...recencyData.keys(), ...statusBoosts.keys()])

  const now = Date.now()
  const records: FrecencyRecord[] = []

  for (const filePath of allPaths) {
    const gitData = recencyData.get(filePath)
    const statusBoost = statusBoosts.get(filePath) ?? 0

    // Calculate normalized recency score (0-1)
    // If file has no git history, recency is 0
    const gitRecency = gitData ? gitRecencyScore(gitData.lastCommit) : 0

    // Frequency is the raw commit count
    const gitFrequency = gitData?.frequency ?? 0

    records.push({
      path: filePath,
      gitRecency,
      gitFrequency,
      gitStatusBoost: statusBoost,
      lastSeen: now,
    })
  }

  return records
}

// ============================================================================
// Ranking
// ============================================================================

/**
 * Apply frecency scores to search results and re-rank.
 *
 * Combines FTS5 relevance score with frecency to produce a final ranking.
 * Results are sorted by finalScore descending (highest first).
 *
 * The final score formula balances text relevance with file activity:
 * - FTS5 score indicates how well the filename matches the query
 * - Frecency score indicates how relevant the file is to current work
 *
 * @param results - Search results from FTS5 query
 * @param frecencyMap - Map of file paths to frecency records
 * @param weights - Weight multipliers from configuration
 * @returns Results with frecency scores, sorted by finalScore
 *
 * @example
 * ```ts
 * const ranked = applyFrecencyRanking(ftsResults, frecencyMap, weights)
 * // ranked[0] is now the most relevant result considering both
 * // text match quality and file activity
 * ```
 */
export function applyFrecencyRanking(
  results: SearchResult[],
  frecencyMap: Map<string, FrecencyRecord>,
  weights: WeightsConfig
): RankedResult[] {
  const ranked: RankedResult[] = results.map(result => {
    const frecency = frecencyMap.get(result.path)

    // Calculate frecency score (0 if not in map)
    const frecencyScore = frecency ? calculateScore(frecency, weights) : 0

    // Combine FTS score with frecency score
    // FTS score is typically 0-based negative (more negative = worse match)
    // or positive where higher is better - normalize accordingly
    // Here we add them since both higher = better
    const finalScore = result.score + frecencyScore

    return {
      ...result,
      frecencyScore,
      finalScore,
    }
  })

  // Sort by finalScore descending (highest first)
  ranked.sort((a, b) => b.finalScore - a.finalScore)

  return ranked
}

// ============================================================================
// Merging Results
// ============================================================================

/**
 * Merge indexed search results with fresh files.
 *
 * Fresh files (from fd --changed-within or similar) may not be in the
 * search index yet. This function adds them with score 0 so they can
 * still be boosted by frecency and appear in results.
 *
 * @param indexed - Results from the FTS5 search index
 * @param fresh - Absolute paths to fresh files not yet indexed
 * @returns Combined results with fresh files added
 *
 * @example
 * ```ts
 * const indexed = await searchIndex(query)
 * const fresh = await findRecentlyModified(projectRoot)
 * const merged = mergeResults(indexed, fresh)
 * // merged includes both indexed results and fresh files
 * ```
 */
export function mergeResults(indexed: SearchResult[], fresh: string[]): SearchResult[] {
  if (fresh.length === 0) {
    return indexed
  }

  // Build a set of paths already in indexed results
  const indexedPaths = new Set(indexed.map(r => r.path))

  // Create SearchResults for fresh files not already indexed
  const freshResults: SearchResult[] = fresh
    .filter(path => !indexedPaths.has(path))
    .map(path => {
      const filename = path.split('/').pop() ?? path
      return {
        path,
        filename,
        relativePath: path,
        score: 0, // Fresh files have no FTS score
      }
    })

  // Combine indexed and fresh results
  return [...indexed, ...freshResults]
}
