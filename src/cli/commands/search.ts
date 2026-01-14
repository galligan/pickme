import { createFilePicker } from '../../index'
import { getDefaultDbPath, openDatabase } from '../../db'
import { loadConfig } from '../../config'
import { expandTilde } from '../../utils'
import {
  error,
  info,
  output,
  EXIT_ERROR,
  EXIT_SUCCESS,
  EXIT_USAGE,
  type OutputOptions,
} from '../core'
import { getEffectiveConfigPath } from '../helpers'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

export async function cmdSearch(
  args: string[],
  opts: OutputOptions,
  getConfigPath: () => string
): Promise<number> {
  const query = args[0]
  if (!query) {
    error('missing search query', opts)
    if (!opts.json) {
      error('Usage: pickme search <query> [--root <path>] [--limit <n>] [--exact] [--paths]', opts)
    }
    return EXIT_USAGE
  }

  const configPath = getEffectiveConfigPath(getConfigPath)
  const config = await loadConfig(configPath)
  if (!config.active) {
    if (opts.json) {
      output({ active: false, results: [] }, opts)
    } else if (!opts.quiet) {
      output('Pickme is disabled (active = false in config).', opts)
    }
    return EXIT_SUCCESS
  }

  let projectRoot = process.cwd()
  let limit = 20
  let exact = false
  let pathsOnly = false

  for (let i = 1; i < args.length; i++) {
    if ((args[i] === '--root' || args[i] === '-r') && args[i + 1]) {
      const nextArg = args[++i]
      if (nextArg !== undefined) {
        projectRoot = nextArg
      }
    } else if ((args[i] === '--limit' || args[i] === '-n') && args[i + 1]) {
      const nextArg = args[++i]
      if (nextArg !== undefined) {
        limit = parseInt(nextArg, 10)
      }
    } else if (args[i] === '--exact') {
      exact = true
    } else if (args[i] === '--paths') {
      pathsOnly = true
    }
  }

  if (exact) {
    const expandedQuery = expandTilde(query)
    const resolvedPath = expandedQuery.startsWith('/')
      ? expandedQuery
      : resolve(projectRoot, expandedQuery)
    const dbPath = getDefaultDbPath()
    if (!existsSync(dbPath)) {
      error('database not found; run `pickme index` first', opts)
      return EXIT_ERROR
    }

    const db = openDatabase(dbPath)
    try {
      const row = db
        .query<{ path: string }, [string]>('SELECT path FROM files_meta WHERE path = ? LIMIT 1')
        .get(resolvedPath)

      if (opts.json) {
        output({ path: resolvedPath, indexed: Boolean(row) }, opts)
      } else if (row) {
        if (opts.quiet || pathsOnly) {
          console.log(row.path)
        } else {
          output(row.path, opts)
        }
      } else if (!opts.quiet) {
        output('Not found in index.', opts)
      }

      return row ? EXIT_SUCCESS : EXIT_ERROR
    } finally {
      db.close()
    }
  }

  info(`Searching for "${query}" in ${projectRoot}...`, opts)

  const picker = await createFilePicker({ configPath })
  try {
    const results = await picker.search(query, { projectRoot, limit })

    if (opts.json) {
      output({ query, projectRoot, results }, opts)
    } else if (results.length === 0) {
      if (!opts.quiet) {
        output('No results found.', opts)
      }
    } else {
      const lines = pathsOnly
        ? results.map(r => r.relativePath)
        : results.map(r => `${r.relativePath}  (score: ${r.score.toFixed(1)})`)
      if (opts.quiet || pathsOnly) {
        console.log(lines.join('\n'))
      } else {
        output(lines.join('\n'), opts)
      }
    }

    return EXIT_SUCCESS
  } finally {
    await picker.close()
  }
}
