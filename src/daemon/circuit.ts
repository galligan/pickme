/**
 * Circuit breaker functionality for daemon stability.
 *
 * Provides timeout wrappers, RSS monitoring, and database error recovery.
 * These mechanisms help the daemon fail gracefully under pressure.
 *
 * @module daemon/circuit
 */

// ============================================================================
// Constants
// ============================================================================

/** Default request timeout in milliseconds */
export const REQUEST_TIMEOUT_MS = 5000

/** RSS threshold for warning (256MB) */
export const RSS_WARN_BYTES = 256 * 1024 * 1024

/** RSS threshold for forced exit (512MB) */
export const RSS_EXIT_BYTES = 512 * 1024 * 1024

// ============================================================================
// Types
// ============================================================================

/**
 * State for circuit breaker tracking.
 */
export interface CircuitState {
  /** Count of consecutive database errors */
  dbErrorCount: number
  /** Timestamp of last RSS check */
  lastRssCheck: number
  /** Interval between RSS checks in milliseconds */
  rssCheckIntervalMs: number
}

/**
 * Action to take based on RSS check.
 */
export type RssAction = 'ok' | 'warn' | 'exit'

/**
 * Action to take based on database error.
 */
export type DbRecoveryAction = 'retry' | 'exit'

// ============================================================================
// State Factory
// ============================================================================

/**
 * Creates a new circuit breaker state.
 *
 * @param rssCheckIntervalMs - Interval between RSS checks (default: 30000ms)
 * @returns Fresh circuit state
 *
 * @example
 * ```ts
 * const circuit = createCircuitState();
 * maybeCheckRss(circuit, onWarn, onExit);
 * ```
 */
export function createCircuitState(rssCheckIntervalMs = 30000): CircuitState {
  return {
    dbErrorCount: 0,
    lastRssCheck: 0,
    rssCheckIntervalMs,
  }
}

// ============================================================================
// Timeout Functions
// ============================================================================

/**
 * Wraps a promise with a timeout.
 *
 * If the promise doesn't resolve within the timeout, rejects with "Request timeout".
 * The timer is unreferenced to prevent blocking process exit.
 *
 * @param promise - Promise to wrap
 * @param timeoutMs - Timeout in milliseconds (default: REQUEST_TIMEOUT_MS)
 * @returns Promise that resolves with the original result or rejects on timeout
 *
 * @example
 * ```ts
 * try {
 *   const result = await withTimeout(fetchData(), 5000);
 * } catch (err) {
 *   if (err.message === 'Request timeout') {
 *     // Handle timeout
 *   }
 * }
 * ```
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number = REQUEST_TIMEOUT_MS
): Promise<T> {
  const timeout = new Promise<never>((_, reject) => {
    const timer = setTimeout(() => reject(new Error('Request timeout')), timeoutMs)
    // Ensure timer doesn't prevent process exit
    if (timer.unref) {
      timer.unref()
    }
  })
  return Promise.race([promise, timeout])
}

// ============================================================================
// RSS Monitoring
// ============================================================================

/**
 * Checks current RSS against thresholds.
 *
 * Returns the appropriate action based on memory usage:
 * - "ok": Memory usage is normal
 * - "warn": Memory usage exceeds warn threshold
 * - "exit": Memory usage exceeds exit threshold
 *
 * @param warnBytes - Warning threshold in bytes (default: RSS_WARN_BYTES)
 * @param exitBytes - Exit threshold in bytes (default: RSS_EXIT_BYTES)
 * @returns Action to take based on memory usage
 */
export function checkRss(
  warnBytes: number = RSS_WARN_BYTES,
  exitBytes: number = RSS_EXIT_BYTES
): RssAction {
  const rss = process.memoryUsage().rss

  if (rss >= exitBytes) {
    return 'exit'
  }

  if (rss >= warnBytes) {
    return 'warn'
  }

  return 'ok'
}

/**
 * Conditionally checks RSS based on the check interval.
 *
 * Only performs the check if enough time has passed since the last check.
 * Calls the appropriate callback based on the RSS status.
 *
 * @param circuit - Circuit state to track last check time
 * @param onWarn - Callback when RSS exceeds warn threshold
 * @param onExit - Callback when RSS exceeds exit threshold
 */
export function maybeCheckRss(circuit: CircuitState, onWarn: () => void, onExit: () => void): void {
  const now = Date.now()
  if (now - circuit.lastRssCheck < circuit.rssCheckIntervalMs) {
    return
  }

  circuit.lastRssCheck = now
  const action = checkRss()

  if (action === 'warn') {
    onWarn()
  } else if (action === 'exit') {
    onExit()
  }
}

// ============================================================================
// Database Error Recovery
// ============================================================================

/**
 * Handles a database error and returns the recovery action.
 *
 * On the first error, returns "retry" to allow a single retry attempt.
 * On subsequent consecutive errors, returns "exit" to trigger shutdown.
 *
 * Call resetDbErrorCount() after a successful database operation
 * to reset the counter.
 *
 * @param circuit - Circuit state to track error count
 * @param _error - The database error (logged externally)
 * @returns Action to take: "retry" on first error, "exit" on subsequent
 */
export function handleDbError(circuit: CircuitState, _error: Error): DbRecoveryAction {
  circuit.dbErrorCount++

  if (circuit.dbErrorCount === 1) {
    return 'retry'
  }

  return 'exit'
}

/**
 * Resets the database error count.
 *
 * Call this after a successful database operation to clear
 * the consecutive error count.
 *
 * @param circuit - Circuit state to reset
 */
export function resetDbErrorCount(circuit: CircuitState): void {
  circuit.dbErrorCount = 0
}
