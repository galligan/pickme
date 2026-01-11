/**
 * Init command for installing pickme hooks into Claude Code.
 *
 * Provides interactive installation of session-start hooks at global
 * and/or project levels.
 *
 * @module init
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { checkbox } from '@inquirer/prompts'
import ora from 'ora'
import { dim, green, red } from 'yoctocolors'

// ============================================================================
// Types
// ============================================================================

/**
 * Installation scope for the pickme hook.
 */
export type InstallScope = 'global' | 'project'

/**
 * Status of Claude configuration detection.
 */
export interface ClaudeConfigStatus {
  /** Path to the settings.json file */
  settingsPath: string
  /** Whether the settings.json file exists */
  exists: boolean
  /** Whether pickme hook is already installed */
  hasPickmeHook: boolean
  /** Path where the hook script should be installed */
  hookScriptPath: string
  /** Whether the hook script exists */
  hookScriptExists: boolean
}

/**
 * Result of the init command.
 */
export interface InitResult {
  success: boolean
  globalInstalled: boolean
  projectInstalled: boolean
  errors: string[]
}

/**
 * Claude settings.json structure (partial - just what we need).
 */
interface ClaudeSettings {
  hooks?: {
    SessionStart?: Array<{
      matcher?: string
      hooks?: Array<{
        type: string
        command: string
      }>
    }>
    [key: string]: unknown
  }
  [key: string]: unknown
}

// ============================================================================
// Claude Config Detection
// ============================================================================

/**
 * Gets Claude Code's config directory.
 *
 * Claude Code uses ~/.claude by default. This function checks:
 * 1. ~/.claude (Claude Code's default location)
 * 2. $XDG_CONFIG_HOME/claude (if ~/.claude doesn't exist and XDG is set)
 *
 * @returns Path to Claude's config directory
 */
export function getClaudeConfigDir(): string {
  // Claude Code uses ~/.claude by default
  const defaultPath = join(homedir(), '.claude')
  if (existsSync(defaultPath)) {
    return defaultPath
  }

  // Fallback to XDG if default doesn't exist
  if (process.env.XDG_CONFIG_HOME) {
    const xdgPath = join(process.env.XDG_CONFIG_HOME, 'claude')
    if (existsSync(xdgPath)) {
      return xdgPath
    }
  }

  // Return default even if it doesn't exist (will be created)
  return defaultPath
}

/**
 * Gets the path to pickme's installation directory.
 *
 * @returns Absolute path to the pickme project
 */
export function getPickmeDir(): string {
  // __dirname points to src/, so go up one level
  return resolve(dirname(__dirname))
}

/**
 * Detects the status of Claude configuration for a given scope.
 *
 * @param scope - Whether to check global or project config
 * @param projectDir - Project directory (only used for project scope)
 * @returns Configuration status
 */
export function detectClaudeConfig(
  scope: InstallScope,
  projectDir: string = process.cwd()
): ClaudeConfigStatus {
  let settingsDir: string

  if (scope === 'global') {
    settingsDir = getClaudeConfigDir()
  } else {
    settingsDir = join(projectDir, '.claude')
  }

  const settingsPath = join(settingsDir, 'settings.json')
  // Hook script goes directly in the claude config dir (not in hooks subdir)
  const hookScriptPath = join(settingsDir, 'file-suggestion.sh')
  const exists = existsSync(settingsPath)
  const hookScriptExists = existsSync(hookScriptPath)

  let hasPickmeHook = false
  if (exists) {
    try {
      const content = readFileSync(settingsPath, 'utf-8')
      const settings = JSON.parse(content) as ClaudeSettings
      hasPickmeHook = checkForPickmeHook(settings)
    } catch {
      // If we can't read the file, assume no hook
    }
  }

  return {
    settingsPath,
    exists,
    hasPickmeHook,
    hookScriptPath,
    hookScriptExists,
  }
}

/**
 * Checks if settings.json already has a pickme hook.
 */
function checkForPickmeHook(settings: ClaudeSettings): boolean {
  const sessionStartHooks = settings.hooks?.SessionStart
  if (!Array.isArray(sessionStartHooks)) {
    return false
  }

  for (const hookGroup of sessionStartHooks) {
    const hooks = hookGroup.hooks
    if (!Array.isArray(hooks)) continue

    for (const hook of hooks) {
      if (
        hook.type === 'command' &&
        (hook.command.includes('file-suggestion.sh') ||
          hook.command.includes('file-picker.sh') ||
          hook.command.includes('pickme'))
      ) {
        return true
      }
    }
  }

  return false
}

// ============================================================================
// Hook Script Generation
// ============================================================================

/**
 * Generates the file-suggestion.sh hook script content.
 *
 * @param pickmeDir - Path to pickme installation
 * @returns Shell script content
 */
export function generateHookScript(pickmeDir: string): string {
  return `#!/bin/bash
# pickme session-start hook
# Runs pickme session hook when Claude Code starts

PICKME_DIR=""

# Check if pickme is on PATH
if command -v pickme &>/dev/null; then
  PICKME_CMD="$(command -v pickme)"
  PICKME_DIR="$(dirname "$(dirname "$PICKME_CMD")")"
  [[ ! -d "$PICKME_DIR/hooks" ]] && PICKME_DIR=""
fi

# Fallback: known dev location
[[ -z "$PICKME_DIR" && -d "${pickmeDir}" ]] && PICKME_DIR="${pickmeDir}"

# Fallback: Homebrew
if [[ -z "$PICKME_DIR" ]]; then
  for prefix in /opt/homebrew /usr/local; do
    [[ -d "$prefix/lib/node_modules/pickme/hooks" ]] && PICKME_DIR="$prefix/lib/node_modules/pickme" && break
  done
fi

# Exit silently if not found
[[ -z "$PICKME_DIR" ]] && exit 0

# Verify bun is available
command -v bun &>/dev/null || exit 0

# Run in background
nohup bun run "$PICKME_DIR/hooks/session-start.ts" >/dev/null 2>&1 &
exit 0
`
}

// ============================================================================
// Installation Logic
// ============================================================================

/**
 * Backs up an existing file by renaming it to .bak
 *
 * @param filePath - Path to the file to back up
 * @returns Whether backup was created
 */
function backupIfExists(filePath: string): boolean {
  if (existsSync(filePath)) {
    const backupPath = `${filePath}.bak`
    renameSync(filePath, backupPath)
    return true
  }
  return false
}

/**
 * Installs the pickme hook for a given scope.
 *
 * @param scope - Whether to install globally or in project
 * @param projectDir - Project directory (for project scope)
 * @returns Success status
 */
export async function installHook(
  scope: InstallScope,
  projectDir: string = process.cwd()
): Promise<{ success: boolean; error?: string; backedUp?: boolean }> {
  const status = detectClaudeConfig(scope, projectDir)
  const pickmeDir = getPickmeDir()

  try {
    // Create config directory if it doesn't exist
    const configDir = dirname(status.hookScriptPath)
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true })
    }

    // Back up existing hook script
    const backedUp = backupIfExists(status.hookScriptPath)

    // Write the hook script
    const scriptContent = generateHookScript(pickmeDir)
    writeFileSync(status.hookScriptPath, scriptContent, { mode: 0o755 })

    // Update settings.json
    const settingsDir = dirname(status.settingsPath)
    if (!existsSync(settingsDir)) {
      mkdirSync(settingsDir, { recursive: true })
    }

    let settings: ClaudeSettings = {}
    if (status.exists) {
      try {
        const content = readFileSync(status.settingsPath, 'utf-8')
        settings = JSON.parse(content) as ClaudeSettings
      } catch {
        // If file exists but can't be parsed, start fresh
        settings = {}
      }
    }

    // Add the hook to settings
    settings = addHookToSettings(settings, status.hookScriptPath)

    // Write updated settings
    writeFileSync(status.settingsPath, JSON.stringify(settings, null, 2) + '\n')

    return { success: true, backedUp }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Adds pickme hook to settings without duplicating.
 */
function addHookToSettings(
  settings: ClaudeSettings,
  hookScriptPath: string
): ClaudeSettings {
  // Initialize hooks object if needed
  if (!settings.hooks) {
    settings.hooks = {}
  }

  // Initialize SessionStart array if needed
  if (!settings.hooks.SessionStart) {
    settings.hooks.SessionStart = []
  }

  // Check if we already have a pickme hook
  const sessionStart = settings.hooks.SessionStart as Array<{
    matcher?: string
    hooks?: Array<{ type: string; command: string }>
  }>

  const hasPickme = sessionStart.some((group) =>
    group.hooks?.some(
      (h) =>
        h.type === 'command' &&
        (h.command.includes('file-suggestion.sh') ||
          h.command.includes('file-picker.sh') ||
          h.command.includes('pickme'))
    )
  )

  if (!hasPickme) {
    // Add new hook entry
    sessionStart.push({
      hooks: [
        {
          type: 'command',
          command: hookScriptPath,
        },
      ],
    })
  }

  return settings
}

// ============================================================================
// Interactive Init Flow
// ============================================================================

/**
 * Runs the interactive init command.
 *
 * @param projectDir - Current project directory
 * @returns Init result
 */
export async function runInit(
  projectDir: string = process.cwd()
): Promise<InitResult> {
  const result: InitResult = {
    success: true,
    globalInstalled: false,
    projectInstalled: false,
    errors: [],
  }

  console.log('\nPickme Configuration\n')

  // Detection phase - instant, no spinner
  const globalStatus = detectClaudeConfig('global', projectDir)
  const projectStatus = detectClaudeConfig('project', projectDir)

  const globalInstalled =
    globalStatus.hasPickmeHook || globalStatus.hookScriptExists
  const projectInstalled =
    projectStatus.hasPickmeHook || projectStatus.hookScriptExists

  // Display status
  displayConfigStatus('Global config', globalStatus.exists)
  displayInstallStatus(
    'Global install',
    globalInstalled,
    globalStatus.hookScriptPath
  )
  console.log()
  displayConfigStatus('Project config', projectStatus.exists)
  displayInstallStatus(
    'Project install',
    projectInstalled,
    projectStatus.hookScriptPath
  )
  console.log()

  // Build choices for installation
  type Choice = {
    name: string
    value: InstallScope
    disabled: boolean
  }

  const choices: Choice[] = [
    {
      name: globalInstalled
        ? dim(`${green('\u2714')} Global (already installed)`)
        : 'Global',
      value: 'global',
      disabled: globalInstalled,
    },
    {
      name: projectInstalled
        ? dim(`${green('\u2714')} Project (already installed)`)
        : 'Project',
      value: 'project',
      disabled: projectInstalled,
    },
  ]

  // Check if all options are disabled
  const allDisabled = choices.every((c) => c.disabled)
  if (allDisabled) {
    console.log('Pickme hooks are already installed in all locations.\n')
    return result
  }

  // Prompt for scope selection
  let selectedScopes: InstallScope[] = []
  try {
    selectedScopes = await checkbox({
      message: 'Install pickme?',
      choices,
    })
  } catch (err) {
    // User cancelled (Ctrl+C)
    if (err instanceof Error && err.message.includes('User force closed')) {
      console.log('\nInstallation cancelled.\n')
      result.success = false
      return result
    }
    throw err
  }

  if (selectedScopes.length === 0) {
    console.log('\nNo scopes selected. Nothing to install.\n')
    return result
  }

  console.log()

  // Install in each selected scope with spinners
  for (const scope of selectedScopes) {
    const scopeLabel = scope === 'global' ? 'Global' : 'Project'
    const installSpinner = ora(`Installing ${scopeLabel.toLowerCase()}...`).start()

    const installResult = await installHook(scope, projectDir)

    if (installResult.success) {
      let msg = `${scopeLabel} installed`
      if (installResult.backedUp) {
        msg += ' (previous version backed up)'
      }
      installSpinner.succeed(msg)
      if (scope === 'global') {
        result.globalInstalled = true
      } else {
        result.projectInstalled = true
      }
    } else {
      installSpinner.fail(`Failed to install ${scopeLabel.toLowerCase()}: ${installResult.error}`)
      result.errors.push(installResult.error ?? 'Unknown error')
      result.success = false
    }
  }

  console.log()

  return result
}

/**
 * Display config detection status line.
 */
function displayConfigStatus(label: string, detected: boolean): void {
  if (detected) {
    console.log(`${green('\u2714')} ${label} detected`)
  } else {
    console.log(`${red('\u2717')} ${label} not found`)
  }
}

/**
 * Display install status line.
 */
function displayInstallStatus(
  label: string,
  installed: boolean,
  path: string
): void {
  const displayPath = path.replace(homedir(), '~')
  if (installed) {
    console.log(`${green('\u2714')} ${label} ${displayPath}`)
  } else {
    console.log(`${red('\u2717')} ${label} not found ${dim(displayPath)}`)
  }
}
