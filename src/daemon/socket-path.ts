/**
 * Socket path resolution for the pickme daemon.
 *
 * Follows XDG Base Directory Specification for runtime files,
 * with secure fallback to /tmp for systems without XDG_RUNTIME_DIR.
 *
 * @module daemon/socket-path
 */

import { mkdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// ============================================================================
// Socket Path Resolution
// ============================================================================

/**
 * Gets the directory where the daemon socket file should be stored.
 *
 * Uses XDG Base Directory Specification with secure fallback:
 * 1. $XDG_RUNTIME_DIR/pickme (if XDG_RUNTIME_DIR is set and non-empty)
 * 2. /tmp/pickme-{uid} (fallback for macOS and systems without XDG)
 *
 * The fallback includes the user ID to prevent socket collisions between
 * users on multi-user systems.
 *
 * @returns Absolute path to the socket directory
 */
export function getSocketDir(): string {
  const xdgRuntime = process.env.XDG_RUNTIME_DIR
  if (xdgRuntime && xdgRuntime.length > 0) {
    return join(xdgRuntime, 'pickme')
  }
  // Fallback for macOS and systems without XDG_RUNTIME_DIR
  const uid = process.getuid?.() ?? 0
  return join('/tmp', `pickme-${uid}`)
}

/**
 * Gets the full path to the daemon Unix socket.
 *
 * @returns Absolute path to the socket file (pickme.sock)
 */
export function getSocketPath(): string {
  return join(getSocketDir(), 'pickme.sock')
}

// ============================================================================
// Directory Management
// ============================================================================

/**
 * Ensures the socket directory exists with secure permissions.
 *
 * Creates the directory with mode 0700 (owner read/write/execute only).
 * If the directory already exists, verifies it has secure permissions
 * and throws if the permissions are too permissive.
 *
 * @returns The socket directory path
 * @throws {Error} If the existing directory has insecure permissions
 */
export function ensureSocketDir(): string {
  const dir = getSocketDir()

  try {
    mkdirSync(dir, { mode: 0o700, recursive: true })
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err
    }
  }

  // Always verify permissions (directory may have existed or been just created)
  const stat = statSync(dir)
  const mode = stat.mode & 0o777

  // Secure permissions: only owner should have any access (0700)
  // Reject if group or others have any permissions
  if (mode !== 0o700) {
    throw new Error(
      `Socket directory ${dir} has insecure permissions (${mode.toString(8)}). Expected 0700.`
    )
  }

  return dir
}
