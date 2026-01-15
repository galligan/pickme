import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  unlinkSync,
  readdirSync,
  statSync,
} from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { expandTilde, getDataDir } from '../../packages/core/src/utils'
import { getClaudeConfigDir } from '../../packages/core/src/init'

export function shellEscape(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export function getEffectiveConfigPath(getConfigPath: () => string): string {
  return process.env.PICKME_CONFIG_PATH ?? getConfigPath()
}

export function getDebugRootsPath(): string {
  const claudeDir = getClaudeConfigDir()
  return process.env.PICKME_DEBUG_FILE ?? join(claudeDir, 'pickme-debug-roots')
}

function normalizeRootPath(value: string): string {
  if (value === '/') return '/'
  return value.replace(/\/+$/, '')
}

export function readDebugRoots(filePath: string): string[] {
  if (!existsSync(filePath)) return []
  const lines = readFileSync(filePath, 'utf8').split('\n')
  const roots: string[] = []
  for (const line of lines) {
    const stripped = line.replace(/#.*/, '').trim()
    if (!stripped) continue
    roots.push(normalizeRootPath(stripped))
  }
  return roots
}

export function writeDebugRoots(filePath: string, roots: string[]): void {
  const dir = dirname(filePath)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  if (roots.length === 0) {
    if (existsSync(filePath)) {
      unlinkSync(filePath)
    }
    return
  }
  const content = roots.join('\n') + '\n'
  writeFileSync(filePath, content)
}

export function resolveDebugTarget(arg?: string): string {
  const cwd = process.env.PWD ?? process.cwd()
  if (!arg) return normalizeRootPath(cwd)
  const expanded = expandTilde(arg)
  if (expanded.startsWith('/')) return normalizeRootPath(expanded)
  return normalizeRootPath(resolve(cwd, expanded))
}

export function isDebugEnabledForPath(target: string, roots: readonly string[]): boolean {
  for (const root of roots) {
    if (root === '/') return true
    if (target === root || target.startsWith(`${root}/`)) {
      return true
    }
  }
  return false
}

/**
 * Finds the most specific root that contains the target path.
 *
 * The `root === '/'` check allows the filesystem root to match any path as a
 * fallback. The length comparison ensures more specific roots (longer paths)
 * are preferred over less specific ones, so `/home/user` beats `/` even if
 * `/` appears first in the array.
 */
export function findBestMatchingRoot(target: string, roots: readonly string[]): string | null {
  let match: string | null = null
  for (const root of roots) {
    // Check if target is within this root (exact match, prefix match, or root is filesystem root)
    if (target === root || target.startsWith(`${root}/`) || root === '/') {
      // Prefer longer (more specific) roots over shorter ones
      if (!match || root.length > match.length) {
        match = root
      }
    }
  }
  return match
}

export function findLatestDebugLog(dataDir: string): string | null {
  if (!existsSync(dataDir)) return null
  const entries = readdirSync(dataDir)
    .filter(name => name.startsWith('pickme-debug-') && name.endsWith('.log'))
    .map(name => {
      const fullPath = join(dataDir, name)
      let mtime = 0
      try {
        mtime = statSync(fullPath).mtimeMs
      } catch {
        // Ignore stat errors
      }
      return { name, fullPath, mtime }
    })
    .filter(entry => entry.mtime > 0)

  if (entries.length === 0) return null
  entries.sort((a, b) => b.mtime - a.mtime)
  const first = entries[0]
  return first ? first.fullPath : null
}

export function findLatestDebugLogForCwd(dataDir: string, cwd: string): string | null {
  if (!existsSync(dataDir)) return null
  const entries = readdirSync(dataDir)
    .filter(name => name.startsWith('pickme-debug-') && name.endsWith('.log'))
    .map(name => {
      const fullPath = join(dataDir, name)
      let mtime = 0
      try {
        mtime = statSync(fullPath).mtimeMs
      } catch {
        // Ignore stat errors
      }
      return { name, fullPath, mtime }
    })
    .filter(entry => entry.mtime > 0)
    .sort((a, b) => b.mtime - a.mtime)

  for (const entry of entries) {
    try {
      const content = readFileSync(entry.fullPath, 'utf8')
      if (content.includes(`cwd=${cwd}`)) {
        return entry.fullPath
      }
    } catch {
      // Ignore read errors
    }
  }

  return entries[0]?.fullPath ?? null
}

export type DebugRecord = {
  timestamp: string
  mode: string
  query: string
  status: number
  results: number
  durationMs: number
}

export function parseDebugLog(content: string): DebugRecord[] {
  const startRe = /^\[(?<ts>[^\]]+)\]\s+start\s+mode=(?<mode>\S+)\s+query=(?<query>.*?)\s+cwd=/
  const endRe =
    /^\[(?<ts>[^\]]+)\]\s+end\s+mode=(?<mode>\S+)\s+status=(?<status>-?\d+)\s+results=(?<results>\d+)\s+duration_ms=(?<duration>\d+)/
  const pending = new Map<string, { query: string; timestamp: string }>()
  const records: DebugRecord[] = []

  for (const line of content.split('\n')) {
    const startMatch = line.match(startRe)
    if (startMatch?.groups) {
      const { mode, query, ts } = startMatch.groups
      if (mode && query && ts) {
        pending.set(mode, {
          query,
          timestamp: ts,
        })
      }
      continue
    }

    const endMatch = line.match(endRe)
    if (endMatch?.groups) {
      const { mode, ts, status, results, duration } = endMatch.groups
      if (mode && ts && status && results && duration) {
        const start = pending.get(mode)
        if (start) {
          pending.delete(mode)
        }
        records.push({
          timestamp: ts,
          mode,
          query: start?.query ?? '(unknown)',
          status: Number(status),
          results: Number(results),
          durationMs: Number(duration),
        })
      }
    }
  }

  return records
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const idx = Math.floor((sorted.length - 1) * p)
  return sorted[idx] ?? 0
}

export function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`
}

export function truncateSessionId(sessionId: string, length: number = 8): string {
  const cleaned = sessionId.replace(/^session-/, '')
  return cleaned.length > length ? cleaned.slice(0, length) : cleaned
}

export type SessionSummary = {
  sessionId: string
  startedAt: Date
  logPath: string
  queryCount: number
}

export function listDebugSessions(dataDir: string): SessionSummary[] {
  if (!existsSync(dataDir)) return []
  const entries = readdirSync(dataDir)
    .filter(name => name.startsWith('pickme-debug-') && name.endsWith('.log'))
    .map(name => {
      const logPath = join(dataDir, name)
      let mtime = 0
      try {
        mtime = statSync(logPath).mtimeMs
      } catch {
        // Ignore stat errors
      }
      return { name, logPath, mtime }
    })

  const summaries: SessionSummary[] = []
  const sessionStartRe = /^\[(?<ts>[^\]]+)\]\s+session_start\s+session=(?<session>\S+)/

  for (const entry of entries) {
    try {
      const content = readFileSync(entry.logPath, 'utf8')
      const lines = content.split('\n')
      let sessionId = entry.name.replace(/^pickme-debug-/, '').replace(/\.log$/, '')
      let startedAt = entry.mtime ? new Date(entry.mtime) : new Date()

      for (const line of lines) {
        const match = line.match(sessionStartRe)
        if (match?.groups) {
          const { session, ts } = match.groups
          if (session) {
            sessionId = session
          }
          if (ts) {
            const parsed = new Date(ts)
            if (!Number.isNaN(parsed.getTime())) {
              startedAt = parsed
            }
          }
          break
        }
      }

      const records = parseDebugLog(content)
      summaries.push({
        sessionId,
        startedAt,
        logPath: entry.logPath,
        queryCount: records.length,
      })
    } catch {
      // Ignore unreadable logs
    }
  }

  return summaries
}

export { expandTilde, getDataDir }
