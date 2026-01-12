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
import select from '@inquirer/select'
import ora from 'ora'
import { bold, cyan, dim, green } from 'yoctocolors'

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
  const hookScriptPath = join(settingsDir, 'file-suggester.sh')
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
        (hook.command.includes('file-suggester.sh') ||
          hook.command.includes('file-suggestion.sh') ||
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
 * Generates the file-suggester.sh hook script content.
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
        (h.command.includes('file-suggester.sh') ||
          h.command.includes('file-suggestion.sh') ||
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
 * Select theme with cyan pointer and custom styling.
 */
const selectTheme = {
  prefix: { idle: green('?'), done: green('?') },
  icon: { cursor: cyan('\u276F') }, // ❯ in cyan/teal
  style: {
    disabled: (text: string) => dim(text),
    highlight: (text: string) => text, // No special highlighting, pointer indicates selection
    help: (text: string) => dim(text), // Dim the navigation hints
  },
}

/**
 * Prompts user with select, supporting 'q' to quit.
 * Returns null if user cancels.
 */
async function selectWithQuit<T>(config: {
  message: string
  choices: Array<{ name: string; value: T; disabled?: boolean | string }>
}): Promise<T | null> {
  // Set up 'q' key listener
  const stdin = process.stdin
  const wasRaw = stdin.isRaw
  let cancelled = false
  let selectPromise: (ReturnType<typeof select<T>>) | null = null

  const onKeypress = (data: Buffer) => {
    const key = data.toString()
    if (key === 'q' || key === 'Q') {
      cancelled = true
      if (selectPromise) {
        selectPromise.cancel()
      }
    }
  }

  stdin.on('data', onKeypress)

  try {
    selectPromise = select<T>({
      ...config,
      theme: selectTheme,
    })
    const result = await selectPromise
    return result
  } catch (err) {
    // User cancelled (Ctrl+C or 'q')
    if (
      cancelled ||
      (err instanceof Error &&
        (err.message.includes('User force closed') ||
          err.name === 'ExitPromptError'))
    ) {
      return null
    }
    throw err
  } finally {
    stdin.removeListener('data', onKeypress)
    // Restore raw mode if it was changed
    if (stdin.isRaw !== wasRaw && stdin.isTTY) {
      stdin.setRawMode(wasRaw)
    }
  }
}

/**
 * Builds the choice name with proper styling.
 *
 * Format: "Globally (~/.claude)" or "Globally (~/.claude) (installed)"
 * - Path is dim
 * - Entire line is dim if installed
 */
function buildChoiceName(
  label: string,
  path: string,
  isInstalled: boolean
): string {
  const pathPart = dim(`(${path})`)
  const baseName = `${label} ${pathPart}`

  if (isInstalled) {
    return dim(`${label} (${path}) (installed)`)
  }
  return baseName
}

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

  // Header - bold title, dim subtitle
  console.log()
  console.log(bold(`Install ${cyan('Pickme')} file suggester for Claude`))
  console.log(dim('\u2192 This will add .claude/file-suggester.sh'))
  console.log()

  // Silent detection phase
  const globalStatus = detectClaudeConfig('global', projectDir)
  const projectStatus = detectClaudeConfig('project', projectDir)

  // Determine installation status
  // "Fully installed" = script exists AND registered in settings.json
  const globalFullyInstalled =
    globalStatus.hasPickmeHook && globalStatus.hookScriptExists
  const projectFullyInstalled =
    projectStatus.hasPickmeHook && projectStatus.hookScriptExists

  // "Partially installed" = script exists but NOT in settings.json (needs override confirmation)
  const globalScriptOnly =
    globalStatus.hookScriptExists && !globalStatus.hasPickmeHook
  const projectScriptOnly =
    projectStatus.hookScriptExists && !projectStatus.hasPickmeHook

  // Check if all options are fully installed
  if (globalFullyInstalled && projectFullyInstalled) {
    console.log('Pickme is already installed in all locations.\n')
    return result
  }

  // Build choices with styled names
  // Note: "Project " has trailing space to align parentheses with "Globally"
  type Choice = {
    name: string
    value: InstallScope
    disabled: boolean | string
  }

  const choices: Choice[] = [
    {
      name: buildChoiceName('Globally', '~/.claude', globalFullyInstalled),
      value: 'global',
      disabled: globalFullyInstalled,
    },
    {
      name: buildChoiceName('Project ', './.claude', projectFullyInstalled),
      value: 'project',
      disabled: projectFullyInstalled,
    },
  ]

  // Check if all options are disabled
  const allDisabled = choices.every((c) => c.disabled !== false)
  if (allDisabled) {
    console.log('Pickme is already installed in all locations.\n')
    return result
  }

  // Prompt for scope selection
  const selectedScope = await selectWithQuit<InstallScope>({
    message: 'Install location:',
    choices,
  })

  if (selectedScope === null) {
    console.log('\nInstallation cancelled.\n')
    result.success = false
    return result
  }

  // Check if we need override confirmation
  const needsOverride =
    (selectedScope === 'global' && globalScriptOnly) ||
    (selectedScope === 'project' && projectScriptOnly)

  if (needsOverride) {
    const status =
      selectedScope === 'global' ? globalStatus : projectStatus
    const displayPath = status.hookScriptPath.replace(homedir(), '~')

    const confirmed = await selectWithQuit<boolean>({
      message: `Ok to override ${displayPath}?`,
      choices: [
        {
          name: `Yes\n  ${dim('Current file will be saved as file-suggester.sh.bak')}`,
          value: true,
          disabled: false,
        },
        {
          name: 'No, cancel installation',
          value: false,
          disabled: false,
        },
      ],
    })

    if (confirmed === null || confirmed === false) {
      console.log('\nInstallation cancelled.\n')
      result.success = false
      return result
    }
  }

  console.log()

  // Install in selected scope with spinner
  const scopeLabel = selectedScope === 'global' ? 'Global' : 'Project'
  const installSpinner = ora(
    `Installing ${scopeLabel.toLowerCase()}...`
  ).start()

  const installResult = await installHook(selectedScope, projectDir)

  if (installResult.success) {
    let msg = `${scopeLabel} installed`
    if (installResult.backedUp) {
      msg += ' (previous version backed up)'
    }
    installSpinner.succeed(msg)
    if (selectedScope === 'global') {
      result.globalInstalled = true
    } else {
      result.projectInstalled = true
    }
  } else {
    installSpinner.fail(
      `Failed to install ${scopeLabel.toLowerCase()}: ${installResult.error}`
    )
    result.errors.push(installResult.error ?? 'Unknown error')
    result.success = false
  }

  console.log()

  return result
}
