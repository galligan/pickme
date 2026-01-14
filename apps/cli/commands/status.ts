import { loadConfig } from '../../../packages/core/src/config'
import { getDefaultDbPath, getWatchedRoots, openDatabase } from '../../../packages/core/src/db'
import { output, EXIT_SUCCESS, type OutputOptions } from '../core'
import { getEffectiveConfigPath } from '../helpers'
import { existsSync } from 'node:fs'

export async function cmdStatus(opts: OutputOptions, getConfigPath: () => string): Promise<number> {
  const configPath = getEffectiveConfigPath(getConfigPath)
  const config = await loadConfig(configPath)
  const dbPath = getDefaultDbPath()
  const dbExists = existsSync(dbPath)

  let roots: Array<{ root: string; fileCount: number | null; lastIndexed: number | null }> = []
  if (dbExists) {
    const db = openDatabase(dbPath)
    try {
      roots = getWatchedRoots(db)
    } finally {
      db.close()
    }
  }

  if (opts.json) {
    output(
      {
        database: {
          path: dbPath,
          exists: dbExists,
        },
        active: config.active,
        config: {
          roots: config.index.roots,
          maxDepth: config.index.depth.default,
          excludePatterns: config.index.exclude.patterns.length,
        },
        indexedRoots: roots.map(r => ({
          root: r.root,
          fileCount: r.fileCount,
          lastIndexed: r.lastIndexed ? new Date(r.lastIndexed).toISOString() : null,
        })),
      },
      opts
    )
  } else {
    output('Pickme Status\n', opts)
    output(`Active: ${config.active ? 'yes' : 'no'}`, opts)
    output(`Database: ${dbPath}`, opts)
    output(`  Exists: ${dbExists ? 'yes' : 'no'}`, opts)
    output('', opts)
    output('Configuration:', opts)
    output(`  Roots: ${config.index.roots.join(', ') || '(none)'}`, opts)
    output(`  Max depth: ${config.index.depth.default}`, opts)
    output(`  Exclude patterns: ${config.index.exclude.patterns.length}`, opts)

    if (roots.length > 0) {
      output('', opts)
      output('Indexed roots:', opts)
      for (const r of roots) {
        const lastIndexed = r.lastIndexed ? new Date(r.lastIndexed).toLocaleString() : 'never'
        output(`  ${r.root}`, opts)
        output(`    Files: ${r.fileCount ?? 'unknown'}, Last indexed: ${lastIndexed}`, opts)
      }
    }
  }

  return EXIT_SUCCESS
}
