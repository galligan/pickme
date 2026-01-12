/**
 * Self-update functionality for pickme CLI.
 *
 * Downloads and installs the latest version from GitHub releases.
 *
 * @module update
 */

import { existsSync, unlinkSync, renameSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { Writable } from 'node:stream'

// ============================================================================
// Types
// ============================================================================

/**
 * GitHub release asset.
 */
interface ReleaseAsset {
  name: string
  browser_download_url: string
  size: number
}

/**
 * GitHub release info.
 */
interface ReleaseInfo {
  tag_name: string
  name: string
  body: string
  published_at: string
  assets: ReleaseAsset[]
}

/**
 * Result of checking for updates.
 */
export interface UpdateCheckResult {
  currentVersion: string
  latestVersion: string
  hasUpdate: boolean
  releaseNotes?: string
  publishedAt?: string
}

/**
 * Result of performing an update.
 */
export interface UpdateResult {
  success: boolean
  previousVersion: string
  newVersion: string
  error?: string
}

// ============================================================================
// Constants
// ============================================================================

const REPO = 'galligan/pickme'
const GITHUB_API = 'https://api.github.com'
const INSTALL_DIR = join(homedir(), '.local', 'bin')
const BINARY_NAME = 'pickme'

// ============================================================================
// Platform Detection
// ============================================================================

/**
 * Gets the platform identifier for the current system.
 *
 * @returns Platform string like "darwin-arm64" or "linux-x64"
 */
export function getPlatform(): string {
  const os = process.platform === 'darwin' ? 'darwin' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  return `${os}-${arch}`
}

/**
 * Gets the expected asset name for the current platform.
 *
 * @returns Asset filename like "pickme-darwin-arm64.tar.gz"
 */
export function getAssetName(): string {
  return `pickme-${getPlatform()}.tar.gz`
}

// ============================================================================
// Version Comparison
// ============================================================================

/**
 * Parses a version string into components.
 *
 * @param version - Version string like "1.2.3" or "v1.2.3"
 * @returns Array of [major, minor, patch]
 */
function parseVersion(version: string): [number, number, number] {
  const clean = version.replace(/^v/, '')
  const parts = clean.split('.').map((p) => parseInt(p, 10) || 0)
  return [parts[0] || 0, parts[1] || 0, parts[2] || 0]
}

/**
 * Compares two version strings.
 *
 * @returns 1 if a > b, -1 if a < b, 0 if equal
 */
export function compareVersions(a: string, b: string): number {
  const [aMajor, aMinor, aPatch] = parseVersion(a)
  const [bMajor, bMinor, bPatch] = parseVersion(b)

  if (aMajor !== bMajor) return aMajor > bMajor ? 1 : -1
  if (aMinor !== bMinor) return aMinor > bMinor ? 1 : -1
  if (aPatch !== bPatch) return aPatch > bPatch ? 1 : -1
  return 0
}

// ============================================================================
// GitHub API
// ============================================================================

/**
 * Fetches the latest release from GitHub.
 *
 * @returns Release info or null if not found
 */
export async function getLatestRelease(): Promise<ReleaseInfo | null> {
  const url = `${GITHUB_API}/repos/${REPO}/releases/latest`

  try {
    const response = await fetch(url, {
      headers: {
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'pickme-cli',
      },
    })

    if (!response.ok) {
      if (response.status === 404) {
        return null // No releases yet
      }
      throw new Error(`GitHub API error: ${response.status}`)
    }

    return (await response.json()) as ReleaseInfo
  } catch (err) {
    throw new Error(
      `Failed to check for updates: ${err instanceof Error ? err.message : String(err)}`
    )
  }
}

// ============================================================================
// Update Check
// ============================================================================

/**
 * Checks if an update is available.
 *
 * @param currentVersion - Current installed version
 * @returns Update check result
 */
export async function checkForUpdate(
  currentVersion: string
): Promise<UpdateCheckResult> {
  const release = await getLatestRelease()

  if (!release) {
    return {
      currentVersion,
      latestVersion: currentVersion,
      hasUpdate: false,
    }
  }

  const latestVersion = release.tag_name.replace(/^v/, '')
  const hasUpdate = compareVersions(latestVersion, currentVersion) > 0

  return {
    currentVersion,
    latestVersion,
    hasUpdate,
    releaseNotes: release.body,
    publishedAt: release.published_at,
  }
}

// ============================================================================
// Download and Install
// ============================================================================

/**
 * Downloads a file to a temporary location.
 *
 * @param url - URL to download from
 * @param onProgress - Optional progress callback (0-100)
 * @returns Path to downloaded file
 */
async function downloadFile(
  url: string,
  onProgress?: (percent: number) => void
): Promise<string> {
  const response = await fetch(url, {
    headers: {
      'User-Agent': 'pickme-cli',
    },
  })

  if (!response.ok) {
    throw new Error(`Download failed: ${response.status}`)
  }

  const contentLength = parseInt(response.headers.get('content-length') || '0', 10)
  const tmpPath = join(INSTALL_DIR, '.pickme-download.tar.gz')

  const chunks: Uint8Array[] = []
  let downloaded = 0

  const reader = response.body?.getReader()
  if (!reader) {
    throw new Error('Failed to read response body')
  }

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    downloaded += value.length
    if (onProgress && contentLength > 0) {
      onProgress(Math.round((downloaded / contentLength) * 100))
    }
  }

  const buffer = Buffer.concat(chunks)
  await Bun.write(tmpPath, buffer)

  return tmpPath
}

/**
 * Extracts and installs the binary from a tarball.
 *
 * @param tarPath - Path to the downloaded tarball
 * @param assetName - Name of the binary inside the tarball
 */
async function extractAndInstall(tarPath: string, assetName: string): Promise<void> {
  const binaryName = assetName.replace('.tar.gz', '')
  const binaryPath = join(INSTALL_DIR, BINARY_NAME)
  const backupPath = `${binaryPath}.bak`

  // Extract tarball
  const result = Bun.spawnSync(['tar', '-xzf', tarPath, '-C', INSTALL_DIR], {
    stdout: 'pipe',
    stderr: 'pipe',
  })

  if (result.exitCode !== 0) {
    throw new Error(`Failed to extract: ${result.stderr.toString()}`)
  }

  const extractedPath = join(INSTALL_DIR, binaryName)

  // Backup existing binary
  if (existsSync(binaryPath)) {
    renameSync(binaryPath, backupPath)
  }

  try {
    // Move new binary into place
    renameSync(extractedPath, binaryPath)
    chmodSync(binaryPath, 0o755)

    // Remove backup on success
    if (existsSync(backupPath)) {
      unlinkSync(backupPath)
    }
  } catch (err) {
    // Restore backup on failure
    if (existsSync(backupPath)) {
      renameSync(backupPath, binaryPath)
    }
    throw err
  } finally {
    // Cleanup download
    if (existsSync(tarPath)) {
      unlinkSync(tarPath)
    }
  }
}

/**
 * Downloads and installs an update.
 *
 * @param currentVersion - Current installed version
 * @param onProgress - Optional progress callback
 * @returns Update result
 */
export async function performUpdate(
  currentVersion: string,
  onProgress?: (message: string, percent?: number) => void
): Promise<UpdateResult> {
  try {
    onProgress?.('Checking for updates...')
    const release = await getLatestRelease()

    if (!release) {
      return {
        success: false,
        previousVersion: currentVersion,
        newVersion: currentVersion,
        error: 'No releases found',
      }
    }

    const latestVersion = release.tag_name.replace(/^v/, '')

    if (compareVersions(latestVersion, currentVersion) <= 0) {
      return {
        success: true,
        previousVersion: currentVersion,
        newVersion: currentVersion,
        error: 'Already up to date',
      }
    }

    // Find the asset for our platform
    const assetName = getAssetName()
    const asset = release.assets.find((a) => a.name === assetName)

    if (!asset) {
      return {
        success: false,
        previousVersion: currentVersion,
        newVersion: currentVersion,
        error: `No binary available for ${getPlatform()}`,
      }
    }

    onProgress?.(`Downloading v${latestVersion}...`, 0)

    const tarPath = await downloadFile(asset.browser_download_url, (percent) => {
      onProgress?.(`Downloading v${latestVersion}...`, percent)
    })

    onProgress?.('Installing...')
    await extractAndInstall(tarPath, assetName)

    return {
      success: true,
      previousVersion: currentVersion,
      newVersion: latestVersion,
    }
  } catch (err) {
    return {
      success: false,
      previousVersion: currentVersion,
      newVersion: currentVersion,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
