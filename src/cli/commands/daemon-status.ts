/**
 * Daemon status command.
 *
 * Shows whether the daemon is running and its health metrics.
 *
 * @module cli/commands/daemon-status
 */

import { existsSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { getConfigPath, loadConfig } from '../../config'
import { sendRequest } from '../../daemon/client'
import { getSocketPath } from '../../daemon/socket-path'
import { EXIT_SUCCESS, type OutputOptions } from '../core'
import { getEffectiveConfigPath } from '../helpers'

// ============================================================================
// Types
// ============================================================================

/**
 * Parsed arguments for the daemon status command.
 */
export interface DaemonStatusArgs {
  /** Output as JSON */
  readonly json: boolean
}

/**
 * Health information from the daemon.
 */
interface DaemonHealth {
  readonly uptime: number
  readonly rss: number
  readonly generation: number
  readonly cacheHitRate: number
  readonly activeWatchers: number
  readonly rootsLoaded: readonly string[]
}

/**
 * Status output structure.
 */
interface StatusOutput {
  running: boolean
  socketPath: string
  socketExists: boolean
  health?: DaemonHealth
  error?: string
}

// ============================================================================
// Argument Parsing
// ============================================================================

/**
 * Parses command line arguments for the daemon status command.
 */
export function parseDaemonStatusArgs(args: readonly string[]): DaemonStatusArgs {
  const { values } = parseArgs({
    args: args as string[],
    options: {
      json: {
        type: 'boolean',
        short: 'j',
        default: false,
      },
    },
    strict: false,
    allowPositionals: true,
  })

  return {
    json: values.json as boolean,
  }
}

// ============================================================================
// Status Command
// ============================================================================

/**
 * Runs the daemon status command.
 *
 * @param args - Command line arguments
 * @param flags - Global output flags
 * @returns Exit code
 */
export async function cmdDaemonStatus(
  args: readonly string[],
  flags: OutputOptions
): Promise<number> {
  const statusArgs = parseDaemonStatusArgs(args)

  // Use effective config path (respects PICKME_CONFIG_PATH env var)
  const configPath = getEffectiveConfigPath(getConfigPath)
  const config = await loadConfig(configPath)
  const socketPath = config.daemon.socket_path ?? getSocketPath()

  const status: StatusOutput = {
    running: false,
    socketPath,
    socketExists: existsSync(socketPath),
  }

  if (status.socketExists) {
    try {
      const response = await sendRequest(socketPath, { type: 'health' }, 2000)
      if (response.ok && response.health) {
        status.running = true
        status.health = response.health as DaemonHealth
      }
    } catch (e) {
      status.error = e instanceof Error ? e.message : 'Unknown error'
    }
  }

  // Honor both global --json flag and local -j flag
  if (flags.json || statusArgs.json) {
    console.log(JSON.stringify(status, null, 2))
  } else {
    printStatus(status)
  }

  return EXIT_SUCCESS
}

/**
 * Prints human-readable status output.
 */
function printStatus(status: StatusOutput): void {
  console.log('Daemon Status')
  console.log('-------------')
  console.log(`Socket: ${status.socketPath}`)
  console.log(`Running: ${status.running ? 'yes' : 'no'}`)

  if (!status.running) {
    if (status.socketExists) {
      console.log('Note: Stale socket file exists (daemon crashed?)')
    }
    if (status.error) {
      console.log(`Error: ${status.error}`)
    }
    return
  }

  if (status.health) {
    const h = status.health
    const uptimeMin = Math.floor(h.uptime / 60)
    const uptimeSec = h.uptime % 60
    const rssMB = (h.rss / 1024 / 1024).toFixed(1)
    const hitRate = (h.cacheHitRate * 100).toFixed(1)

    console.log(`Uptime: ${uptimeMin}m ${uptimeSec}s`)
    console.log(`Memory: ${rssMB} MB`)
    console.log(`Cache hit rate: ${hitRate}%`)
    console.log(`Index generation: ${h.generation}`)
    console.log(`Active watchers: ${h.activeWatchers}`)
    console.log(`Roots loaded: ${h.rootsLoaded.length}`)

    if (h.rootsLoaded.length > 0 && h.rootsLoaded.length <= 5) {
      for (const r of h.rootsLoaded) {
        console.log(`  - ${r}`)
      }
    }
  }
}
