import { createFilePicker } from '../../index'
import { error, info, output, EXIT_ERROR, EXIT_SUCCESS, type OutputOptions } from '../core'
import { getEffectiveConfigPath } from '../helpers'
import { existsSync } from 'node:fs'

export async function cmdIndex(
  args: string[],
  opts: OutputOptions,
  getConfigPath: () => string
): Promise<number> {
  const dir = args[0] || process.cwd()
  const configPath = getEffectiveConfigPath(getConfigPath)

  if (!existsSync(dir)) {
    error(`directory not found: ${dir}`, opts)
    return EXIT_ERROR
  }

  info(`Indexing ${dir}...`, opts)

  const picker = await createFilePicker({ configPath })
  try {
    const result = await picker.ensureIndexed([dir])

    if (opts.json) {
      output(
        {
          directory: dir,
          filesIndexed: result.filesIndexed,
          filesSkipped: result.filesSkipped,
          errors: result.errors,
        },
        opts
      )
    } else {
      output(`Indexed: ${result.filesIndexed} files`, opts)
      if (result.filesSkipped > 0) {
        output(`Skipped: ${result.filesSkipped} files`, opts)
      }
      if (result.errors.length > 0) {
        console.error(`Errors: ${result.errors.length}`)
        result.errors.slice(0, 5).forEach(e => console.error(`  ${e}`))
      }
    }

    return result.errors.length > 0 ? EXIT_ERROR : EXIT_SUCCESS
  } finally {
    await picker.close()
  }
}

export async function cmdRefresh(
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

  info(`Refreshing index for ${dir}...`, opts)

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
      const label = force ? 'Force refreshed' : 'Refreshed'
      output(`${label}: ${result.filesIndexed} files in ${result.duration.toFixed(0)}ms`, opts)
      if (result.errors.length > 0) {
        console.error(`Errors: ${result.errors.length}`)
        result.errors.slice(0, 5).forEach(e => console.error(`  ${e}`))
      }
    }

    return result.errors.length > 0 ? EXIT_ERROR : EXIT_SUCCESS
  } finally {
    await picker.close()
  }
}
