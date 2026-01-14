import { parseGlobalFlags, EXIT_ERROR, EXIT_SUCCESS, EXIT_USAGE, error } from './core'
import { showHelp } from './help'
import { cmdSearch } from './commands/search'
import { cmdIndex, cmdRefresh } from './commands/index'
import { cmdStatus } from './commands/status'
import { cmdRoots } from './commands/roots'
import { cmdConfig, cmdSetActive, cmdToggle } from './commands/config'
import { cmdDebug } from './commands/debug'
import { cmdInit } from './commands/init'
import { cmdUpdate } from './commands/update'
import { cmdBench } from './commands/bench'
import { cmdServe } from './commands/serve'
import { cmdQuery } from './commands/query'
import { cmdDaemonStatus } from './commands/daemon-status'
import { NAME } from './constants'
import { getConfigPath } from '../config'
import { VERSION } from '../version'

export async function main(): Promise<number> {
  const { flags, rest } = parseGlobalFlags(process.argv.slice(2))
  const command = rest[0]
  const args = rest.slice(1)

  if (flags.debug) {
    process.env.PICKME_DEBUG = '1'
  }

  if (rest.includes('--help') || rest.includes('-h') || command === 'help') {
    showHelp()
    return EXIT_SUCCESS
  }

  if (rest.includes('--version') || rest.includes('-v')) {
    console.log(VERSION)
    return EXIT_SUCCESS
  }

  if (!command) {
    showHelp()
    return EXIT_USAGE
  }

  try {
    switch (command) {
      case 'search':
        return await cmdSearch(args, flags, getConfigPath)
      case 'query':
        return await cmdQuery(args, flags)
      case 'index':
        return await cmdIndex(args, flags, getConfigPath)
      case 'refresh':
        return await cmdRefresh(args, flags, getConfigPath)
      case 'status':
        return await cmdStatus(flags, getConfigPath)
      case 'roots':
        return await cmdRoots(flags, getConfigPath)
      case 'config':
        return await cmdConfig(args, flags)
      case 'enable':
        return await cmdSetActive(true, flags)
      case 'disable':
        return await cmdSetActive(false, flags)
      case 'toggle':
        return await cmdToggle(flags)
      case 'debug':
        return await cmdDebug(args, flags)
      case 'bench':
        return await cmdBench(args, flags)
      case 'init':
        return await cmdInit(flags)
      case 'update':
        return await cmdUpdate(args, flags)
      case 'serve':
        return await cmdServe(args, flags)
      case 'daemon':
        // Subcommand: daemon status
        if (args[0] === 'status') {
          return await cmdDaemonStatus(args.slice(1), flags)
        }
        // Unknown daemon subcommand
        error(`unknown daemon subcommand: ${args[0] ?? '(none)'}`, flags)
        return EXIT_USAGE
      default:
        error(`unknown command: ${command}`, flags)
        if (!flags.json) {
          error(`Run '${NAME} --help' for usage.`, flags)
        }
        return EXIT_USAGE
    }
  } catch (err) {
    error(err instanceof Error ? err.message : String(err), flags)
    return EXIT_ERROR
  }
}
