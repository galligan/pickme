/**
 * Query command for minimal file search output.
 *
 * Outputs paths only (one per line) for use by hooks and scripts.
 * Uses daemon when available, falls back to direct search.
 *
 * @module cli/commands/query
 */

import { parseArgs } from 'node:util'
import { getConfigPath, loadConfig } from '../../config'
import { isDaemonRunning, queryDaemon } from '../../daemon/client'
import { getSocketPath } from '../../daemon/socket-path'
import { createFilePicker, type FilePicker } from '../../index'
import type { OutputOptions } from '../core'

// ============================================================================
// Types
// ============================================================================

/**
 * Parsed arguments for the query command.
 */
export interface QueryArgs {
  /** Search query pattern */
  readonly query: string
  /** Working directory (default: process.cwd()) */
  readonly cwd: string
  /** Maximum results (default: 50) */
  readonly limit: number
  /** Skip daemon, use CLI directly */
  readonly noDaemon: boolean
}

/**
 * Error thrown when argument parsing fails.
 */
export class QueryArgsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'QueryArgsError'
  }
}

// ============================================================================
// Argument Parsing
// ============================================================================

/**
 * Parses command line arguments for the query command.
 *
 * @param args - Command line arguments (after 'query')
 * @returns Parsed arguments
 * @throws {QueryArgsError} If arguments are invalid
 */
export function parseQueryArgs(args: readonly string[]): QueryArgs {
  try {
    const { values, positionals } = parseArgs({
      args: args as string[],
      options: {
        cwd: {
          type: 'string',
          short: 'C',
        },
        limit: {
          type: 'string',
          short: 'l',
          default: '50',
        },
        'no-daemon': {
          type: 'boolean',
          default: false,
        },
      },
      strict: false,
      allowPositionals: true,
    })

    if (positionals.length === 0) {
      throw new QueryArgsError('missing required argument: query pattern')
    }

    const query = positionals[0] as string
    const cwd = (values.cwd as string | undefined) ?? process.cwd()
    const limitStr = values.limit as string
    const limit = Number(limitStr)

    if (Number.isNaN(limit) || limit <= 0 || !Number.isInteger(limit)) {
      throw new QueryArgsError(`invalid limit: "${limitStr}"`)
    }

    return {
      query,
      cwd,
      limit,
      noDaemon: (values['no-daemon'] ?? false) as boolean,
    }
  } catch (err) {
    if (err instanceof QueryArgsError) {
      throw err
    }
    throw new QueryArgsError(err instanceof Error ? err.message : String(err))
  }
}

// ============================================================================
// Query Command
// ============================================================================

/**
 * Runs the query command.
 *
 * Outputs matching file paths, one per line.
 * Uses daemon when available, falls back to direct FilePicker search.
 *
 * @param args - Command line arguments
 * @param flags - Global output flags (unused for minimal output)
 * @returns Exit code
 */
export async function cmdQuery(args: readonly string[], _flags: OutputOptions): Promise<number> {
  let queryArgs: QueryArgs
  try {
    queryArgs = parseQueryArgs(args)
  } catch (err) {
    if (err instanceof QueryArgsError) {
      console.error(`pickme query: ${err.message}`)
      return 2
    }
    throw err
  }

  const { query, cwd, limit, noDaemon } = queryArgs

  // Try daemon first (unless disabled)
  if (!noDaemon) {
    const socketPath = getSocketPath()
    const daemonAvailable = await isDaemonRunning(socketPath)

    if (daemonAvailable) {
      try {
        const response = await queryDaemon(socketPath, { query, cwd, limit })
        for (const result of response.results) {
          console.log(result.path)
        }
        return 0
      } catch {
        // Fall through to direct search
      }
    }
  }

  // Direct search fallback
  const configPath = getConfigPath()
  let picker: FilePicker

  try {
    picker = await createFilePicker({ configPath })
  } catch (err) {
    console.error(
      `pickme query: failed to initialize: ${err instanceof Error ? err.message : String(err)}`
    )
    return 1
  }

  try {
    const results = await picker.search(query, {
      projectRoot: cwd,
      limit,
    })

    for (const result of results) {
      console.log(result.path)
    }

    return 0
  } catch (err) {
    console.error(
      `pickme query: search failed: ${err instanceof Error ? err.message : String(err)}`
    )
    return 1
  } finally {
    await picker.close()
  }
}
