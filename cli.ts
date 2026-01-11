#!/usr/bin/env bun
/**
 * CLI for the pickme file picker.
 *
 * Provides fast file search with FTS5 indexing and frecency-based ranking.
 *
 * @example
 * ```sh
 * # Search for files
 * pickme search "button component"
 * pickme search "@*.ts" --root ~/project
 *
 * # Index a directory
 * pickme index ~/Developer
 *
 * # Refresh an existing index
 * pickme refresh ~/project
 *
 * # Check status
 * pickme status
 * ```
 */

import { createFilePicker } from './src/index'
import { getDefaultDbPath, openDatabase, getWatchedRoots } from './src/db'
import { loadConfig } from './src/config'
import { existsSync } from 'node:fs'

// ============================================================================
// Constants
// ============================================================================

const VERSION = '1.0.0'
const NAME = 'pickme'

// Exit codes
const EXIT_SUCCESS = 0
const EXIT_ERROR = 1
const EXIT_USAGE = 2

// ============================================================================
// Output Utilities
// ============================================================================

interface OutputOptions {
  json: boolean
  quiet: boolean
  noColor: boolean
}

const isTTY = process.stdout.isTTY ?? false
const supportsColor = isTTY && !process.env.NO_COLOR

function parseGlobalFlags(args: string[]): { flags: OutputOptions; rest: string[] } {
  const flags: OutputOptions = {
    json: false,
    quiet: false,
    noColor: !supportsColor,
  }
  const rest: string[] = []

  for (const arg of args) {
    switch (arg) {
      case '--json':
        flags.json = true
        break
      case '--quiet':
      case '-q':
        flags.quiet = true
        break
      case '--no-color':
        flags.noColor = true
        break
      default:
        rest.push(arg)
    }
  }

  return { flags, rest }
}

function output(data: unknown, opts: OutputOptions): void {
  if (opts.quiet) return

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2))
  } else if (typeof data === 'string') {
    console.log(data)
  } else {
    console.log(data)
  }
}

function error(message: string, opts: OutputOptions): void {
  if (opts.json) {
    console.error(JSON.stringify({ error: message }))
  } else {
    console.error(`${NAME}: ${message}`)
  }
}

function info(message: string, opts: OutputOptions): void {
  if (opts.quiet) return
  if (opts.json) return // Info goes to stderr in JSON mode
  console.error(message) // Progress/info to stderr
}

// ============================================================================
// Commands
// ============================================================================

async function cmdSearch(args: string[], opts: OutputOptions): Promise<number> {
  const query = args[0]
  if (!query) {
    error('missing search query', opts)
    console.error('Usage: pickme search <query> [--root <path>] [--limit <n>]')
    return EXIT_USAGE
  }

  // Parse command-specific flags
  let projectRoot = process.cwd()
  let limit = 20

  for (let i = 1; i < args.length; i++) {
    if ((args[i] === '--root' || args[i] === '-r') && args[i + 1]) {
      projectRoot = args[++i]
    } else if ((args[i] === '--limit' || args[i] === '-n') && args[i + 1]) {
      limit = parseInt(args[++i], 10)
    }
  }

  info(`Searching for "${query}" in ${projectRoot}...`, opts)

  const picker = await createFilePicker()
  try {
    const results = await picker.search(query, { projectRoot, limit })

    if (opts.json) {
      output({ query, projectRoot, results }, opts)
    } else if (results.length === 0) {
      output('No results found.', opts)
    } else {
      const lines = results.map((r) => `${r.relativePath}  (score: ${r.score.toFixed(1)})`)
      output(lines.join('\n'), opts)
    }

    return EXIT_SUCCESS
  } finally {
    await picker.close()
  }
}

async function cmdIndex(args: string[], opts: OutputOptions): Promise<number> {
  const dir = args[0] || process.cwd()

  if (!existsSync(dir)) {
    error(`directory not found: ${dir}`, opts)
    return EXIT_ERROR
  }

  info(`Indexing ${dir}...`, opts)

  const picker = await createFilePicker()
  try {
    const result = await picker.ensureIndexed([dir])

    if (opts.json) {
      output({
        directory: dir,
        filesIndexed: result.filesIndexed,
        filesSkipped: result.filesSkipped,
        errors: result.errors,
      }, opts)
    } else {
      output(`Indexed: ${result.filesIndexed} files`, opts)
      if (result.filesSkipped > 0) {
        output(`Skipped: ${result.filesSkipped} files`, opts)
      }
      if (result.errors.length > 0) {
        console.error(`Errors: ${result.errors.length}`)
        result.errors.slice(0, 5).forEach((e) => console.error(`  ${e}`))
      }
    }

    return result.errors.length > 0 ? EXIT_ERROR : EXIT_SUCCESS
  } finally {
    await picker.close()
  }
}

async function cmdRefresh(args: string[], opts: OutputOptions): Promise<number> {
  const dir = args[0] || process.cwd()

  if (!existsSync(dir)) {
    error(`directory not found: ${dir}`, opts)
    return EXIT_ERROR
  }

  info(`Refreshing index for ${dir}...`, opts)

  const picker = await createFilePicker()
  try {
    const result = await picker.refreshIndex(dir)

    if (opts.json) {
      output({
        directory: dir,
        filesIndexed: result.filesIndexed,
        duration: result.duration,
        errors: result.errors,
      }, opts)
    } else {
      output(`Refreshed: ${result.filesIndexed} files in ${result.duration.toFixed(0)}ms`, opts)
      if (result.errors.length > 0) {
        console.error(`Errors: ${result.errors.length}`)
        result.errors.slice(0, 5).forEach((e) => console.error(`  ${e}`))
      }
    }

    return result.errors.length > 0 ? EXIT_ERROR : EXIT_SUCCESS
  } finally {
    await picker.close()
  }
}

async function cmdStatus(opts: OutputOptions): Promise<number> {
  const config = await loadConfig()
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
    output({
      database: {
        path: dbPath,
        exists: dbExists,
      },
      config: {
        roots: config.index.roots,
        maxDepth: config.index.depth.default,
        excludePatterns: config.index.exclude.patterns.length,
      },
      indexedRoots: roots.map((r) => ({
        root: r.root,
        fileCount: r.fileCount,
        lastIndexed: r.lastIndexed ? new Date(r.lastIndexed).toISOString() : null,
      })),
    }, opts)
  } else {
    output('Pickme Status\n', opts)
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
        const lastIndexed = r.lastIndexed
          ? new Date(r.lastIndexed).toLocaleString()
          : 'never'
        output(`  ${r.root}`, opts)
        output(`    Files: ${r.fileCount ?? 'unknown'}, Last indexed: ${lastIndexed}`, opts)
      }
    }
  }

  return EXIT_SUCCESS
}

function showHelp(): void {
  console.log(`${NAME} v${VERSION} - Fast file search for Claude Code

USAGE
  ${NAME} <command> [options]

COMMANDS
  search <query>     Search for files matching query
  index <path>       Index a directory
  refresh <path>     Refresh an existing index
  status             Show index status and configuration

SEARCH OPTIONS
  -r, --root <path>  Project root for relative paths (default: cwd)
  -n, --limit <n>    Maximum results (default: 20)

GLOBAL OPTIONS
  --json             Output as JSON
  -q, --quiet        Suppress non-essential output
  --no-color         Disable colored output
  -h, --help         Show this help
  -v, --version      Show version

EXAMPLES
  ${NAME} search "button"
  ${NAME} search "@*.ts" --root ~/project --limit 50
  ${NAME} index ~/Developer
  ${NAME} refresh .
  ${NAME} status --json

ENVIRONMENT
  PICKME_DEBUG=1     Enable debug logging
  NO_COLOR           Disable colored output
`)
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<number> {
  const { flags, rest } = parseGlobalFlags(process.argv.slice(2))
  const command = rest[0]
  const args = rest.slice(1)

  // Handle global flags
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
        return await cmdSearch(args, flags)
      case 'index':
        return await cmdIndex(args, flags)
      case 'refresh':
        return await cmdRefresh(args, flags)
      case 'status':
        return await cmdStatus(flags)
      default:
        error(`unknown command: ${command}`, flags)
        console.error(`Run '${NAME} --help' for usage.`)
        return EXIT_USAGE
    }
  } catch (err) {
    error(err instanceof Error ? err.message : String(err), flags)
    return EXIT_ERROR
  }
}

main().then((code) => process.exit(code))
