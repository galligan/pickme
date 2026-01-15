/**
 * Index generation tracking for cache invalidation.
 *
 * Uses SQLite's user_version pragma to track generation numbers,
 * enabling efficient cache invalidation when the index changes.
 *
 * @module daemon/generation
 */

import type { Database } from 'bun:sqlite'

// ============================================================================
// Types
// ============================================================================

/**
 * State for tracking generation changes.
 */
export interface GenerationState {
  /** Current generation number */
  current: number
  /** Timestamp of last check (ms since epoch) */
  lastChecked: number
}

// ============================================================================
// Generation Functions
// ============================================================================

/**
 * Reads the current generation number from the database.
 *
 * Uses SQLite's user_version pragma which persists across connections.
 *
 * @param db - Database instance
 * @returns Current generation number (0 for fresh database)
 */
export function readGeneration(db: Database): number {
  const result = db.query<{ user_version: number }, []>('PRAGMA user_version;').get()
  return result?.user_version ?? 0
}

/**
 * Increments the generation number in the database.
 *
 * @param db - Database instance
 * @returns New generation number after increment
 */
export function bumpGeneration(db: Database): number {
  const current = readGeneration(db)
  const next = current + 1
  db.exec(`PRAGMA user_version = ${next};`)
  return next
}

/**
 * Creates a generation tracker initialized with current state.
 *
 * @param db - Database instance
 * @returns Generation state for change detection
 */
export function createGenerationTracker(db: Database): GenerationState {
  return {
    current: readGeneration(db),
    lastChecked: Date.now(),
  }
}

/**
 * Checks if the generation has changed since last check.
 *
 * Updates state.lastChecked on every call.
 * Updates state.current and returns new generation if changed.
 *
 * @param db - Database instance
 * @param state - Mutable generation state to check and update
 * @returns New generation number if changed, undefined otherwise
 */
export function checkGenerationChange(db: Database, state: GenerationState): number | undefined {
  state.lastChecked = Date.now()
  const dbGeneration = readGeneration(db)

  if (dbGeneration !== state.current) {
    state.current = dbGeneration
    return dbGeneration
  }

  return undefined
}
