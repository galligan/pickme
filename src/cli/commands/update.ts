import ora from 'ora'
import { checkForUpdate, performUpdate } from '../../update'
import { VERSION } from '../../version'
import { error, info, output, EXIT_ERROR, EXIT_SUCCESS, type OutputOptions } from '../core'
import { NAME } from '../constants'

export async function cmdUpdate(args: string[], opts: OutputOptions): Promise<number> {
  const checkOnly = args.includes('--check') || args.includes('-c')

  if (checkOnly) {
    info('Checking for updates...', opts)
    try {
      const result = await checkForUpdate(VERSION)

      if (opts.json) {
        output(result, opts)
      } else if (result.hasUpdate) {
        output(`Update available: v${result.currentVersion} → v${result.latestVersion}`, opts)
        if (result.publishedAt) {
          const date = new Date(result.publishedAt).toLocaleDateString()
          output(`Released: ${date}`, opts)
        }
        output(`\nRun '${NAME} update' to install.`, opts)
      } else {
        output(`You're on the latest version (v${result.currentVersion}).`, opts)
      }

      return EXIT_SUCCESS
    } catch (err) {
      error(err instanceof Error ? err.message : String(err), opts)
      return EXIT_ERROR
    }
  }

  const spinner = opts.quiet || opts.json ? null : ora('Checking for updates...').start()

  const result = await performUpdate(VERSION, (message, percent) => {
    if (spinner) {
      if (percent !== undefined) {
        spinner.text = `${message} ${percent}%`
      } else {
        spinner.text = message
      }
    }
  })

  if (opts.json) {
    spinner?.stop()
    output(result, opts)
  } else if (result.success) {
    if (result.previousVersion === result.newVersion) {
      spinner?.succeed(`Already up to date (v${result.newVersion})`)
    } else {
      spinner?.succeed(`Updated: v${result.previousVersion} → v${result.newVersion}`)
    }
  } else {
    spinner?.fail(result.error || 'Update failed')
  }

  return result.success ? EXIT_SUCCESS : EXIT_ERROR
}
