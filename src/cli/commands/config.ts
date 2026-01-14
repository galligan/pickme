import { loadConfig, getConfigPath } from '../../config'
import { ensureConfigFile } from '../../config-template'
import { error, output, EXIT_ERROR, EXIT_SUCCESS, type OutputOptions } from '../core'
import { shellEscape, getEffectiveConfigPath } from '../helpers'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

function setConfigActive(configPath: string, active: boolean): boolean {
  ensureConfigFile(configPath)
  const text = readFileSync(configPath, 'utf8')
  const activeLine = `active = ${active ? 'true' : 'false'}`

  if (text.match(/^\s*active\s*=/m)) {
    const updated = text.replace(/^\s*active\s*=\s*(true|false)(.*)$/m, `${activeLine}$2`)
    if (updated !== text) {
      writeFileSync(configPath, updated)
      return true
    }
    return false
  }

  writeFileSync(configPath, `${activeLine}\n\n${text}`)
  return true
}

export async function cmdConfig(args: string[], opts: OutputOptions): Promise<number> {
  const openFile = args.includes('--open') || args.includes('-o')
  const showFile = args.includes('--show')
  const showPath = args.includes('--path')
  const validate = args.includes('--validate')
  const configPath = getEffectiveConfigPath(getConfigPath)

  if (!openFile && !showFile && !showPath && !validate) {
    if (opts.json) {
      output({ path: configPath }, opts)
    } else {
      output(configPath, opts)
    }
    return EXIT_SUCCESS
  }

  if (showPath) {
    if (opts.json) {
      output({ path: configPath }, opts)
    } else {
      output(configPath, opts)
    }
    return EXIT_SUCCESS
  }

  if (validate) {
    try {
      const exists = existsSync(configPath)
      await loadConfig(configPath)
      if (opts.json) {
        output({ path: configPath, exists, valid: true }, opts)
      } else if (exists) {
        output(`Config OK: ${configPath}`, opts)
      } else {
        output(`No config file found. Using defaults (${configPath})`, opts)
      }
      return EXIT_SUCCESS
    } catch (err) {
      error(err instanceof Error ? err.message : String(err), opts)
      return EXIT_ERROR
    }
  }

  if (showFile) {
    if (!existsSync(configPath)) {
      error(`config file not found: ${configPath}`, opts)
      return EXIT_ERROR
    }
    const content = Bun.file(configPath)
    const text = await content.text()
    output(text, opts)
    return EXIT_SUCCESS
  }

  ensureConfigFile(configPath)

  const editor = process.env.VISUAL || process.env.EDITOR
  let result: { exitCode: number | null; stdout: Buffer; stderr: Buffer }

  if (editor) {
    const command = `${editor} ${shellEscape(configPath)}`
    result = Bun.spawnSync(['/bin/sh', '-c', command], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } else {
    const opener =
      process.platform === 'darwin' ? 'open' : process.platform === 'linux' ? 'xdg-open' : null

    if (!opener) {
      error('unsupported platform for --open (set $EDITOR or $VISUAL)', opts)
      return EXIT_ERROR
    }

    result = Bun.spawnSync([opener, configPath], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
  }

  if (result.exitCode !== 0) {
    const stderr = result.stderr.toString().trim()
    const stdout = result.stdout.toString().trim()
    error(stderr || stdout || 'failed to open config file', opts)
    return EXIT_ERROR
  }

  if (opts.json) {
    output({ path: configPath, opened: true }, opts)
  }

  return EXIT_SUCCESS
}

export async function cmdSetActive(active: boolean, opts: OutputOptions): Promise<number> {
  const configPath = getEffectiveConfigPath(getConfigPath)

  try {
    const current = await loadConfig(configPath)
    const changed = setConfigActive(configPath, active)

    if (opts.json) {
      output(
        {
          path: configPath,
          previous: current.active,
          active,
          changed,
        },
        opts
      )
    } else if (!opts.quiet) {
      if (current.active === active) {
        output(`Pickme already ${active ? 'enabled' : 'disabled'} (${configPath})`, opts)
      } else {
        output(`Pickme ${active ? 'enabled' : 'disabled'} (${configPath})`, opts)
      }
    }

    return EXIT_SUCCESS
  } catch (err) {
    error(err instanceof Error ? err.message : String(err), opts)
    return EXIT_ERROR
  }
}

export async function cmdToggle(opts: OutputOptions): Promise<number> {
  const configPath = getEffectiveConfigPath(getConfigPath)

  try {
    const current = await loadConfig(configPath)
    const next = !current.active
    const changed = setConfigActive(configPath, next)

    if (opts.json) {
      output(
        {
          path: configPath,
          previous: current.active,
          active: next,
          changed,
        },
        opts
      )
    } else if (!opts.quiet) {
      output(`Pickme ${next ? 'enabled' : 'disabled'} (${configPath})`, opts)
    }

    return EXIT_SUCCESS
  } catch (err) {
    error(err instanceof Error ? err.message : String(err), opts)
    return EXIT_ERROR
  }
}
