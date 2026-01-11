/**
 * Init command for installing pickme hooks into Claude Code.
 *
 * Provides interactive installation of session-start hooks at global
 * and/or project levels.
 *
 * @module init
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { checkbox, confirm } from '@inquirer/prompts'
import ora from 'ora'

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
  let hooksDir: string

  if (scope === 'global') {
    settingsDir = getClaudeConfigDir()
    hooksDir = join(settingsDir, 'hooks')
  } else {
    settingsDir = join(projectDir, '.claude')
    hooksDir = join(settingsDir, 'hooks')
  }

  const settingsPath = join(settingsDir, 'settings.json')
  const hookScriptPath = join(hooksDir, 'file-picker.sh')
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
        (hook.command.includes('file-picker.sh') || hook.command.includes('pickme'))
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
 * Generates the file-picker.sh hook script content.
 *
 * @param pickmeDir - Path to pickme installation
 * @returns Shell script content
 */
export function generateHookScript(pickmeDir: string): string {
  return `#!/bin/bash
# pickme session-start hook
# Installed by: pickme init
#
# This script runs the pickme session-start hook when Claude Code starts.
# It refreshes the file index and git frecency data in the background.
#
# Exit codes:
#   0 - Success (or pickme not found - graceful skip)
#   1 - Reserved for fatal errors (currently unused)

# Find pickme installation
PICKME_DIR=""

# First, check if pickme is on PATH
if command -v pickme &> /dev/null; then
  PICKME_CMD="$(command -v pickme)"
  PICKME_DIR="$(dirname "$(dirname "$PICKME_CMD")")"
  # Verify the hooks directory exists
  if [ ! -d "$PICKME_DIR/hooks" ]; then
    PICKME_DIR=""
  fi
fi

# Fallback: check known development location
if [ -z "$PICKME_DIR" ] && [ -d "${pickmeDir}" ]; then
  PICKME_DIR="${pickmeDir}"
fi

# Fallback: check Homebrew locations
if [ -z "$PICKME_DIR" ]; then
  for brew_prefix in /opt/homebrew /usr/local; do
    if [ -d "$brew_prefix/lib/node_modules/pickme/hooks" ]; then
      PICKME_DIR="$brew_prefix/lib/node_modules/pickme"
      break
    fi
  done
fi

# If pickme not found, exit gracefully (not an error)
if [ -z "$PICKME_DIR" ]; then
  # pickme not installed, skip silently
  exit 0
fi

# Verify bun is available
if ! command -v bun &> /dev/null; then
  echo "[pickme] bun not found, skipping session hook" >&2
  exit 0
fi

# Run session-start hook in background to avoid blocking Claude startup
nohup bun run "$PICKME_DIR/hooks/session-start.ts" > /dev/null 2>&1 &

exit 0
`
}

// ============================================================================
// Installation Logic
// ============================================================================

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
): Promise<{ success: boolean; error?: string }> {
  const status = detectClaudeConfig(scope, projectDir)
  const pickmeDir = getPickmeDir()

  try {
    // Create hooks directory if it doesn't exist
    const hooksDir = dirname(status.hookScriptPath)
    if (!existsSync(hooksDir)) {
      mkdirSync(hooksDir, { recursive: true })
    }

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

    return { success: true }
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
function addHookToSettings(settings: ClaudeSettings, hookScriptPath: string): ClaudeSettings {
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
        (h.command.includes('file-picker.sh') || h.command.includes('pickme'))
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
export async function runInit(projectDir: string = process.cwd()): Promise<InitResult> {
  const result: InitResult = {
    success: true,
    globalInstalled: false,
    projectInstalled: false,
    errors: [],
  }

  console.log('\npickme init\n')

  // Detection phase with spinner
  const detectSpinner = ora('Detecting Claude configuration...').start()

  const globalStatus = detectClaudeConfig('global', projectDir)
  const projectStatus = detectClaudeConfig('project', projectDir)

  detectSpinner.succeed('Configuration detected')

  // Display status
  console.log('\nDetected Configuration:')
  displayStatus('Global Claude config', globalStatus.settingsPath, globalStatus.exists)
  displayStatus(
    'Global pickme hook',
    globalStatus.hookScriptPath,
    globalStatus.hasPickmeHook || globalStatus.hookScriptExists,
    globalStatus.hasPickmeHook ? 'installed' : undefined
  )
  displayStatus('Project config', projectStatus.settingsPath, projectStatus.exists)
  displayStatus(
    'Project pickme hook',
    projectStatus.hookScriptPath,
    projectStatus.hasPickmeHook || projectStatus.hookScriptExists,
    projectStatus.hasPickmeHook ? 'installed' : undefined
  )
  console.log()

  // Build choices for installation
  const choices: Array<{
    name: string
    value: InstallScope
    disabled: string | false
  }> = []

  const globalAlreadyInstalled = globalStatus.hasPickmeHook || globalStatus.hookScriptExists
  const projectAlreadyInstalled = projectStatus.hasPickmeHook || projectStatus.hookScriptExists

  choices.push({
    name: `Global (~/.claude/settings.json)`,
    value: 'global',
    disabled: globalAlreadyInstalled ? 'already installed' : false,
  })

  choices.push({
    name: `Project (./.claude/settings.json)`,
    value: 'project',
    disabled: projectAlreadyInstalled ? 'already installed' : false,
  })

  // Check if all options are disabled
  const allDisabled = choices.every((c) => c.disabled !== false)
  if (allDisabled) {
    console.log('pickme hooks are already installed in all locations.\n')
    return result
  }

  // Prompt for scope selection
  let selectedScopes: InstallScope[] = []
  try {
    selectedScopes = await checkbox({
      message: 'Where would you like to install pickme hooks?',
      choices,
      required: true,
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

  // Confirm installation
  const confirmInstall = await confirm({
    message: `Install hooks in ${selectedScopes.length} location(s)?`,
    default: true,
  })

  if (!confirmInstall) {
    console.log('\nInstallation cancelled.\n')
    return result
  }

  console.log()

  // Install in each selected scope
  for (const scope of selectedScopes) {
    const scopeLabel = scope === 'global' ? 'global' : 'project'
    const installSpinner = ora(`Installing ${scopeLabel} hook...`).start()

    const installResult = await installHook(scope, projectDir)

    if (installResult.success) {
      installSpinner.succeed(`${scopeLabel} hook installed`)
      if (scope === 'global') {
        result.globalInstalled = true
      } else {
        result.projectInstalled = true
      }
    } else {
      installSpinner.fail(`Failed to install ${scopeLabel} hook: ${installResult.error}`)
      result.errors.push(installResult.error ?? 'Unknown error')
      result.success = false
    }
  }

  // Show next steps
  console.log('\n--- Next Steps ---')
  console.log('The pickme session-start hook will run automatically when Claude Code starts.')
  console.log('To manually run the hook: pickme session-start')
  console.log('To check index status: pickme status\n')

  return result
}

/**
 * Helper to display a status line with checkmark or X.
 */
function displayStatus(
  label: string,
  path: string,
  exists: boolean,
  note?: string
): void {
  const icon = exists ? '\x1b[32m+\x1b[0m' : '\x1b[31m-\x1b[0m'
  const suffix = note ? ` (${note})` : exists ? '' : ' (not found)'
  // Show relative path for display
  const displayPath = path.replace(homedir(), '~')
  console.log(`  ${icon} ${label}: ${displayPath}${suffix}`)
}
