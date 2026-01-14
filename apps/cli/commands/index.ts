import { createFilePicker } from '../../../packages/core/src/index'
import { error, info, output, EXIT_ERROR, EXIT_SUCCESS, type OutputOptions } from '../core'
import { getEffectiveConfigPath } from '../helpers'
import { existsSync } from 'node:fs'

export async function cmdIndex(
  args: string[],
  opts: OutputOptions,
  getConfigPath: () => string
): Promise<number> {
  const dirArg = args.find(arg => !arg.startsWith('-'))
  const dir = dirArg || process.cwd()
  const configPath = getEffectiveConfigPath(getConfigPath)
  const force = args.includes('--force') || args.includes('--full')

  if (!existsSync(dir)) {
    error(`directory not found: ${dir}`, opts)
    return EXIT_ERROR
  }

  const label = force ? 'Force indexing' : 'Indexing'
  info(`${label} ${dir}...`, opts)

  const picker = await createFilePicker({ configPath })
  try {
    const result = await picker.refreshIndex(dir, { force })

    if (opts.json) {
      output(
        {
          directory: dir,
          filesIndexed: result.filesIndexed,
          duration: result.duration,
          errors: result.errors,
        },
        opts
      )
    } else {
      const doneLabel = force ? 'Force indexed' : 'Indexed'
      output(`${doneLabel}: ${result.filesIndexed} files in ${result.duration.toFixed(0)}ms`, opts)
      if (result.errors.length > 0) {
        error(`Errors: ${result.errors.length}`, opts)
        result.errors.slice(0, 5).forEach(e => error(`  ${e}`, opts))
      }
    }

    return result.errors.length > 0 ? EXIT_ERROR : EXIT_SUCCESS
  } finally {
    await picker.close()
  }
}
