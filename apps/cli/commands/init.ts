import { runInit, type InstallScope } from '../../../packages/core/src/init'
import { EXIT_ERROR, EXIT_SUCCESS, EXIT_USAGE, type OutputOptions, error } from '../core'

export interface InitArgs {
  /** Install scope: 'global' or 'project' */
  scope?: InstallScope
  /** Install Claude plugin (default: true) */
  plugin?: boolean
  /** Include hidden files (default: false) */
  includeHidden?: boolean
}

/**
 * Parses init command arguments.
 *
 * Supported flags:
 *   --global, -g       Install globally (skip scope prompt)
 *   --project, -p      Install for project only (skip scope prompt)
 *   --plugin           Install Claude plugin (default)
 *   --no-plugin        Skip plugin installation
 *   --hidden           Include hidden files
 *   --no-hidden        Exclude hidden files (default)
 */
export function parseInitArgs(args: string[]): InitArgs {
  const result: InitArgs = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    switch (arg) {
      case '--global':
      case '-g':
        result.scope = 'global'
        break
      case '--project':
      case '-p':
        result.scope = 'project'
        break
      case '--plugin':
        result.plugin = true
        break
      case '--no-plugin':
        result.plugin = false
        break
      case '--hidden':
        result.includeHidden = true
        break
      case '--no-hidden':
        result.includeHidden = false
        break
      default:
        // Ignore unknown flags for forward compatibility
        break
    }
  }

  return result
}

export async function cmdInit(args: string[], opts: OutputOptions): Promise<number> {
  const initArgs = parseInitArgs(args)

  // Validate conflicting scope flags
  const hasGlobal = args.includes('--global') || args.includes('-g')
  const hasProject = args.includes('--project') || args.includes('-p')
  if (hasGlobal && hasProject) {
    error('Cannot specify both --global and --project', opts)
    return EXIT_USAGE
  }

  const result = await runInit(process.cwd(), {
    debug: opts.debug,
    scope: initArgs.scope,
    plugin: initArgs.plugin,
    includeHidden: initArgs.includeHidden,
  })
  return result.success ? EXIT_SUCCESS : EXIT_ERROR
}
