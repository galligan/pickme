import select from '@inquirer/select'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { error, output, EXIT_ERROR, EXIT_SUCCESS, type OutputOptions } from '../core'
import {
  formatTimestamp,
  listDebugSessions,
  resolveDebugTarget,
  truncateSessionId,
  getDataDir,
} from '../helpers'
import { readFileSync } from 'node:fs'

export async function cmdBench(args: string[], opts: OutputOptions): Promise<number> {
  const action = args[0]?.toLowerCase()
  const dataDir = getDataDir()

  if (action === 'report') {
    const includeAll = args.includes('--all')
    const cwd = resolveDebugTarget()
    const sessions = includeAll
      ? listDebugSessions(dataDir)
      : listDebugSessions(dataDir).filter(session => {
          try {
            const content = readFileSync(session.logPath, 'utf8')
            return content.includes(`cwd=${cwd}`)
          } catch {
            return false
          }
        })

    if (sessions.length === 0) {
      if (!opts.quiet) {
        output('No debug sessions found.', opts)
      }
      return EXIT_SUCCESS
    }

    const latest = sessions
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, 10)
      .sort((a, b) => a.startedAt.getTime() - b.startedAt.getTime())

    const choices = latest.map(session => {
      const label = `${truncateSessionId(session.sessionId)}  ${formatTimestamp(
        session.startedAt
      )}  ${session.queryCount} ${session.queryCount === 1 ? 'query' : 'queries'}`
      return { name: label, value: session.logPath }
    })

    const selectedLog = await select({
      message: 'Select a session report:',
      choices,
    })

    const { cmdDebug } = await import('./debug')
    return await cmdDebug(['report', '--log', selectedLog], opts)
  }

  let sessionId: string | null = null
  const forwarded: string[] = []
  const passthroughIndex = args.indexOf('--')

  const benchArgs = passthroughIndex === -1 ? args : args.slice(0, passthroughIndex)
  const extraArgs = passthroughIndex === -1 ? [] : args.slice(passthroughIndex + 1)

  for (let i = 0; i < benchArgs.length; i++) {
    const arg = benchArgs[i]
    if (arg === '--session' && benchArgs[i + 1]) {
      sessionId = benchArgs[++i]
    } else {
      forwarded.push(arg)
    }
  }

  const resolvedSessionId = sessionId ?? randomUUID()
  const env = {
    ...process.env,
    PICKME_DEBUG: '1',
    PICKME_DEBUG_SESSION: resolvedSessionId,
  }

  const filteredArgs: string[] = []
  for (let i = 0; i < forwarded.length; i++) {
    const arg = forwarded[i]
    if (arg === '--session-id') {
      i++
      continue
    }
    if (arg.startsWith('--session-id=')) {
      continue
    }
    filteredArgs.push(arg)
  }

  const claudeArgs = [...filteredArgs, '--session-id', resolvedSessionId, ...extraArgs]

  if (!opts.quiet) {
    output(`Bench session: ${resolvedSessionId}`, opts)
  }

  return await new Promise(resolveExit => {
    const child = spawn('claude', claudeArgs, {
      stdio: 'inherit',
      env,
    })

    child.on('error', err => {
      error(`failed to launch claude: ${err instanceof Error ? err.message : String(err)}`, opts)
      resolveExit(EXIT_ERROR)
    })

    child.on('exit', code => {
      resolveExit(code ?? EXIT_ERROR)
    })
  })
}
