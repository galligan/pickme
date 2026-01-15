/**
 * Shared utility functions for the pickme file picker.
 *
 * This module contains pure utility functions that are used across
 * multiple modules. Functions here should only depend on Node/Bun
 * built-ins to avoid circular imports.
 *
 * @module utils
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

// ============================================================================
// Debug Utilities
// ============================================================================

/**
 * Debug logger that only outputs when PICKME_DEBUG env var is set.
 * Use for logging expected failures that don't need user attention.
 *
 * @param context - The subsystem context (e.g., 'prefix', 'frecency', 'hook')
 * @param message - Human-readable description of what happened
 * @param error - Optional error object for additional context
 *
 * @example
 * ```ts
 * debugLog('prefix', 'Failed to resolve namespace', err)
 * debugLog('frecency', 'Git not available, skipping frecency')
 * ```
 */
export function debugLog(context: string, message: string, error?: unknown): void {
  if (process.env.PICKME_DEBUG) {
    if (error) {
      console.debug(`[pickme:${context}]`, message, error)
    } else {
      console.debug(`[pickme:${context}]`, message)
    }
  }
}

// ============================================================================
// XDG Base Directory Utilities
// ============================================================================

/**
 * Gets the XDG config directory for pickme.
 *
 * Uses XDG Base Directory Specification with fallbacks:
 * 1. $XDG_CONFIG_HOME/pickme (if XDG_CONFIG_HOME is set)
 * 2. ~/.config/pickme (if $HOME is set)
 * 3. ~/.pickme (last resort fallback)
 *
 * @returns Absolute path to the config directory
 */
export function getConfigDir(): string {
  if (process.env.XDG_CONFIG_HOME) {
    return join(process.env.XDG_CONFIG_HOME, 'pickme')
  }
  if (process.env.HOME) {
    return join(process.env.HOME, '.config', 'pickme')
  }
  return join(homedir(), '.pickme')
}

/**
 * Gets the XDG data directory for pickme.
 *
 * Uses XDG Base Directory Specification with fallbacks:
 * 1. $XDG_DATA_HOME/pickme (if XDG_DATA_HOME is set)
 * 2. ~/.local/share/pickme (if $HOME is set)
 * 3. ~/.pickme (last resort fallback)
 *
 * @returns Absolute path to the data directory
 */
export function getDataDir(): string {
  if (process.env.XDG_DATA_HOME) {
    return join(process.env.XDG_DATA_HOME, 'pickme')
  }
  if (process.env.HOME) {
    return join(process.env.HOME, '.local', 'share', 'pickme')
  }
  return join(homedir(), '.pickme')
}

/**
 * Gets the plugin directory for pickme.
 *
 * The plugin is stored in the data directory under 'plugin/'.
 *
 * @returns Absolute path to the plugin directory
 */
export function getPluginDir(): string {
  return join(getDataDir(), 'plugin')
}

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Expands ~ to the user's home directory.
 *
 * @param path - Path that may contain ~
 * @returns Path with ~ expanded to home directory
 *
 * @example
 * ```ts
 * expandTilde('~/Developer')  // '/Users/username/Developer'
 * expandTilde('~')            // '/Users/username'
 * expandTilde('/absolute')    // '/absolute'
 * ```
 */
export function expandTilde(path: string): string {
  if (path.startsWith('~/')) {
    return join(homedir(), path.slice(2))
  }
  if (path === '~') {
    return homedir()
  }
  return path
}
