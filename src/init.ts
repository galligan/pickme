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
  writeFileSync,
  renameSync,
} from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import select from '@inquirer/select'
import ora from 'ora'
import { bold, cyan, dim, green, yellow } from 'yoctocolors'
import { getPluginDir } from './utils'

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
  /** Path to Claude's config directory */
  configDir: string
  /** Path where the hook script should be installed */
  hookScriptPath: string
  /** Whether the hook script exists */
  hookScriptExists: boolean
  /** Whether pickme plugin is installed */
  pluginInstalled: boolean
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
  let configDir: string

  if (scope === 'global') {
    configDir = getClaudeConfigDir()
  } else {
    configDir = join(projectDir, '.claude')
  }

  // Hook script goes directly in the claude config dir (not in hooks subdir)
  const hookScriptPath = join(configDir, 'file-suggester.sh')
  const hookScriptExists = existsSync(hookScriptPath)

  // Check if pickme plugin is installed
  const pluginsDir = join(configDir, 'plugins')
  const pluginInstalled = existsSync(join(pluginsDir, 'pickme'))

  return {
    configDir,
    hookScriptPath,
    hookScriptExists,
    pluginInstalled,
  }
}

// ============================================================================
// Hook Script Generation
// ============================================================================

/**
 * Generates the file-suggester.sh script content.
 *
 * This script is called by Claude Code when the user types @ for file suggestions.
 * It runs pickme search with the query and outputs matching file paths.
 *
 * @returns Shell script content
 */
export function generateHookScript(): string {
  return `#!/bin/bash
# pickme file suggester
# Called by Claude Code when user types @ for file suggestions
# Usage: file-suggester.sh <query>

QUERY="\${1:-}"

# If no query, exit silently
[[ -z "$QUERY" ]] && exit 0

# Check standard install location first
PICKME_BIN="\${HOME}/.local/bin/pickme"

# Fallback to PATH
if [[ ! -x "$PICKME_BIN" ]]; then
  PICKME_BIN="$(command -v pickme 2>/dev/null || true)"
fi

# Exit silently if pickme not found
[[ -z "$PICKME_BIN" || ! -x "$PICKME_BIN" ]] && exit 0

# Run search
"$PICKME_BIN" search "$QUERY" --quiet 2>/dev/null
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
 * Options for installHook.
 */
export interface InstallHookOptions {
  /** Whether to install the pickme plugin for Claude Code. Default: true */
  installPlugin?: boolean
}

/**
 * Installs the pickme hook for a given scope.
 *
 * @param scope - Whether to install globally or in project
 * @param projectDir - Project directory (for project scope)
 * @param options - Installation options
 * @returns Success status
 */
export async function installHook(
  scope: InstallScope,
  projectDir: string = process.cwd(),
  options: InstallHookOptions = {}
): Promise<{ success: boolean; error?: string; backedUp?: boolean; pluginInstalled?: boolean }> {
  const { installPlugin = true } = options
  const status = detectClaudeConfig(scope, projectDir)

  try {
    // Create config directory if it doesn't exist
    const configDir = status.configDir
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true })
    }

    // Back up existing hook script
    const backedUp = backupIfExists(status.hookScriptPath)

    // Write the hook script
    const scriptContent = generateHookScript()
    writeFileSync(status.hookScriptPath, scriptContent, { mode: 0o755 })

    let pluginInstalled = false

    // Optionally install the pickme plugin
    if (installPlugin) {
      const pluginDir = getPluginDir()
      const pluginScope = scope === 'global' ? 'user' : 'project'

      // Run: claude plugin install <path> --scope user|project
      const result = Bun.spawnSync(['claude', 'plugin', 'install', pluginDir, '--scope', pluginScope], {
        cwd: projectDir,
        stdout: 'pipe',
        stderr: 'pipe',
      })

      if (result.exitCode === 0) {
        pluginInstalled = true
      } else {
        const stderr = result.stderr.toString()
        // Don't fail if plugin is already installed
        if (!stderr.includes('already installed')) {
          return {
            success: false,
            error: `Failed to install plugin: ${stderr}`,
          }
        }
        pluginInstalled = true // Already installed is success
      }
    }

    return { success: true, backedUp, pluginInstalled }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
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
    help: (text: string) => dim(text + ' • q quit'), // Dim hints + quit
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
  const fullPath = `${path}/file-suggester.sh`
  const pathPart = dim(fullPath)
  const baseName = `${label} ${pathPart}`

  if (isInstalled) {
    return dim(`${label} ${fullPath} (installed)`)
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

  // Header
  console.log()
  console.log(bold('Install Pickme'))
  console.log(dim('An ultrafast @file suggester for Claude'))

  // Silent detection phase
  const globalStatus = detectClaudeConfig('global', projectDir)
  const projectStatus = detectClaudeConfig('project', projectDir)

  // Determine installation status
  // "Fully installed" = script exists AND plugin installed
  const globalFullyInstalled =
    globalStatus.pluginInstalled && globalStatus.hookScriptExists
  const projectFullyInstalled =
    projectStatus.pluginInstalled && projectStatus.hookScriptExists

  // "Partially installed" = script exists but plugin NOT installed (needs override confirmation)
  const globalScriptOnly =
    globalStatus.hookScriptExists && !globalStatus.pluginInstalled
  const projectScriptOnly =
    projectStatus.hookScriptExists && !projectStatus.pluginInstalled

  // Show warning if existing script found (not fully installed)
  const hasExistingScript =
    (globalStatus.hookScriptExists && !globalFullyInstalled) ||
    (projectStatus.hookScriptExists && !projectFullyInstalled)

  if (hasExistingScript) {
    console.log()
    console.log(yellow('Existing file-suggester.sh will be preserved as file-suggester.sh.bak'))
  }

  console.log()

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
      name: buildChoiceName('Globally (best)', '~/.claude', globalFullyInstalled),
      value: 'global',
      disabled: globalFullyInstalled,
    },
    {
      name: buildChoiceName('Project', './.claude', projectFullyInstalled),
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

  // Ask about plugin installation
  const installPluginChoice = await selectWithQuit<boolean>({
    message: `Install Pickme plugin for Claude?\n  ${dim('Adds SessionStart hook for background index refresh')}`,
    choices: [
      {
        name: `Yes ${dim('(recommended)')}`,
        value: true,
        disabled: false,
      },
      {
        name: `No ${dim('(refresh manually with pickme refresh)')}`,
        value: false,
        disabled: false,
      },
    ],
  })

  if (installPluginChoice === null) {
    console.log('\nInstallation cancelled.\n')
    result.success = false
    return result
  }

  console.log()

  // Install in selected scope with spinner
  const scopeLabel = selectedScope === 'global' ? 'Global' : 'Project'
  const installSpinner = ora(
    `Installing ${scopeLabel.toLowerCase()}...`
  ).start()

  const installResult = await installHook(selectedScope, projectDir, {
    installPlugin: installPluginChoice,
  })

  if (installResult.success) {
    let msg = `${scopeLabel} installed`
    if (installResult.backedUp) {
      msg += ' (previous backed up)'
    }
    if (installResult.pluginInstalled) {
      msg += ' + plugin installed'
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
