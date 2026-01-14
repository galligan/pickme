import { error, output, EXIT_ERROR, EXIT_SUCCESS, EXIT_USAGE, type OutputOptions } from '../core'
import {
  findBestMatchingRoot,
  findLatestDebugLog,
  findLatestDebugLogForCwd,
  getDataDir,
  getDebugRootsPath,
  isDebugEnabledForPath,
  parseDebugLog,
  percentile,
  readDebugRoots,
  resolveDebugTarget,
  writeDebugRoots,
} from '../helpers'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expandTilde } from '../../utils'

export async function cmdDebug(args: string[], opts: OutputOptions): Promise<number> {
  const action = args[0]?.toLowerCase() ?? 'status'
  const targetArg = args[1]
  const filePath = getDebugRootsPath()
  const cwd = resolveDebugTarget()

  switch (action) {
    case 'status':
    case 'list': {
      const roots = readDebugRoots(filePath)
      const matchedRoot = findBestMatchingRoot(cwd, roots)
      const enabled = Boolean(matchedRoot)
      if (opts.json) {
        output({ file: filePath, cwd, enabled, matchedRoot, roots }, opts)
      } else {
        output(`Debug file: ${filePath}`, opts)
        output(`Enabled for cwd: ${enabled ? 'yes' : 'no'}`, opts)
        if (matchedRoot) {
          output(`Matched root: ${matchedRoot}`, opts)
        }
        if (roots.length > 0) {
          output('Enabled roots:', opts)
          output(roots.map(r => `  ${r}`).join('\n'), opts)
        } else {
          output('Enabled roots: (none)', opts)
        }
      }
      return EXIT_SUCCESS
    }
    case 'enable':
    case 'on':
    case 'add': {
      const target = resolveDebugTarget(targetArg)
      const roots = readDebugRoots(filePath)
      const exists = roots.includes(target)
      if (!exists) {
        roots.push(target)
        writeDebugRoots(filePath, roots)
      }
      if (opts.json) {
        output({ file: filePath, target, enabled: true, changed: !exists }, opts)
      } else if (!opts.quiet) {
        output(`Debug enabled for ${target}`, opts)
      }
      return EXIT_SUCCESS
    }
    case 'disable':
    case 'off':
    case 'remove': {
      const roots = readDebugRoots(filePath)
      const matchedRoot = findBestMatchingRoot(cwd, roots)
      const target = targetArg ? resolveDebugTarget(targetArg) : matchedRoot
      if (!target) {
        if (opts.json) {
          output({ file: filePath, cwd, enabled: false, changed: false }, opts)
        } else if (!opts.quiet) {
          output('Debug already disabled for cwd', opts)
        }
        return EXIT_SUCCESS
      }
      const next = roots.filter(r => r !== target)
      const changed = next.length !== roots.length
      writeDebugRoots(filePath, next)
      if (opts.json) {
        output({ file: filePath, target, enabled: false, changed }, opts)
      } else if (!opts.quiet) {
        output(`Debug disabled for ${target}`, opts)
      }
      return EXIT_SUCCESS
    }
    case 'toggle': {
      const roots = readDebugRoots(filePath)
      const matchedRoot = findBestMatchingRoot(cwd, roots)
      const target = targetArg ? resolveDebugTarget(targetArg) : (matchedRoot ?? cwd)
      const enabled = isDebugEnabledForPath(target, roots)
      if (enabled) {
        const next = roots.filter(r => r !== target)
        writeDebugRoots(filePath, next)
      } else {
        roots.push(target)
        writeDebugRoots(filePath, roots)
      }
      if (opts.json) {
        output({ file: filePath, target, enabled: !enabled, changed: true }, opts)
      } else if (!opts.quiet) {
        output(`Debug ${enabled ? 'disabled' : 'enabled'} for ${target}`, opts)
      }
      return EXIT_SUCCESS
    }
    case 'report':
    case 'stats':
    case 'summary': {
      let logPath: string | null = null
      let session: string | null = null
      let latestForCwd = false

      for (let i = 1; i < args.length; i++) {
        const arg = args[i]
        if (arg === '--log' && args[i + 1]) {
          const nextArg = args[++i]
          if (nextArg !== undefined) {
            logPath = resolve(expandTilde(nextArg))
          }
        } else if (arg === '--session' && args[i + 1]) {
          const nextArg = args[++i]
          if (nextArg !== undefined) {
            session = nextArg
          }
        } else if (arg === '--latest') {
          latestForCwd = true
        }
      }

      if (!logPath) {
        if (session) {
          const normalized = session.startsWith('session-') ? session : `session-${session}`
          const dataDir = getDataDir()
          const candidate = join(dataDir, `pickme-debug-${normalized}.log`)
          logPath = existsSync(candidate) ? candidate : null
        } else if (latestForCwd) {
          logPath = findLatestDebugLogForCwd(getDataDir(), cwd)
        } else {
          logPath = findLatestDebugLog(getDataDir())
        }
      }

      if (!logPath || !existsSync(logPath)) {
        error('debug log not found (use --log or --session)', opts)
        return EXIT_ERROR
      }

      const content = readFileSync(logPath, 'utf8')
      const records = parseDebugLog(content)

      if (records.length === 0) {
        if (opts.json) {
          output({ log: logPath, total: 0, records: [] }, opts)
        } else {
          output(`No query records found in ${logPath}`, opts)
        }
        return EXIT_SUCCESS
      }

      const durations = records.map(r => r.durationMs)
      const total = records.length
      const totalDuration = durations.reduce((sum, v) => sum + v, 0)
      const avgDuration = totalDuration / total
      const median = percentile(durations, 0.5)
      const p95 = percentile(durations, 0.95)
      const min = Math.min(...durations)
      const max = Math.max(...durations)
      const zeroResults = records.filter(r => r.results === 0).length
      const avgResults = records.reduce((sum, r) => sum + r.results, 0) / total

      const byQuery = new Map<string, { count: number; totalMs: number; maxMs: number }>()
      for (const record of records) {
        const existing = byQuery.get(record.query) ?? { count: 0, totalMs: 0, maxMs: 0 }
        existing.count += 1
        existing.totalMs += record.durationMs
        existing.maxMs = Math.max(existing.maxMs, record.durationMs)
        byQuery.set(record.query, existing)
      }

      const topSlow = [...records]
        .sort((a, b) => b.durationMs - a.durationMs)
        .slice(0, 5)
        .map(r => ({ query: r.query, durationMs: r.durationMs, results: r.results, mode: r.mode }))

      const topQueries = [...byQuery.entries()]
        .map(([query, stats]) => ({
          query,
          count: stats.count,
          avgMs: stats.totalMs / stats.count,
          maxMs: stats.maxMs,
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 5)

      if (opts.json) {
        output(
          {
            log: logPath,
            total,
            avgDurationMs: avgDuration,
            medianDurationMs: median,
            p95DurationMs: p95,
            minDurationMs: min,
            maxDurationMs: max,
            avgResults,
            zeroResults,
            zeroResultsPct: total === 0 ? 0 : zeroResults / total,
            topSlow,
            topQueries,
          },
          opts
        )
      } else {
        output(`Debug report: ${logPath}`, opts)
        output(
          `Queries: ${total} | Avg: ${avgDuration.toFixed(1)}ms | Median: ${median.toFixed(
            1
          )}ms | P95: ${p95.toFixed(1)}ms | Min: ${min}ms | Max: ${max}ms`,
          opts
        )
        output(
          `Avg results: ${avgResults.toFixed(2)} | Zero results: ${zeroResults} (${(
            (zeroResults / total) *
            100
          ).toFixed(1)}%)`,
          opts
        )
        output('Top slow queries:', opts)
        output(
          topSlow.map(r => `  ${r.durationMs}ms  results=${r.results}  ${r.query}`).join('\n'),
          opts
        )
        output('Top frequent queries:', opts)
        output(
          topQueries.map(r => `  ${r.count}x  avg=${r.avgMs.toFixed(1)}ms  ${r.query}`).join('\n'),
          opts
        )
      }

      return EXIT_SUCCESS
    }
    default:
      error(`unknown debug action: ${action}`, opts)
      if (!opts.json) {
        error(
          'Usage: pickme debug [status|enable|disable|toggle|report] [path] [--log <path>] [--session <id>] [--latest]',
          opts
        )
      }
      return EXIT_USAGE
  }
}
