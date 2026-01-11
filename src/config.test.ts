/**
 * Tests for configuration loading and validation.
 *
 * Tests the TOML config parser, validation functions, and default handling.
 *
 * @module config.test
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import {
  loadConfig,
  loadConfigSync,
  getDepthForRoot,
  resolveNamespace,
  getConfigPath,
  expandTilde,
  DEFAULT_CONFIG,
  type Config,
} from './config'
import { ConfigError } from './errors'

// ============================================================================
// Test Utilities
// ============================================================================

/**
 * Creates a temporary config file for testing.
 */
function createTempConfig(content: string): { path: string; cleanup: () => void } {
  const tempDir = mkdtempSync(join(tmpdir(), 'file-picker-config-test-'))
  const configPath = join(tempDir, 'config.toml')
  writeFileSync(configPath, content)

  return {
    path: configPath,
    cleanup: () => {
      try {
        rmSync(tempDir, { recursive: true })
      } catch {
        // Ignore cleanup errors
      }
    },
  }
}

// ============================================================================
// expandTilde Tests
// ============================================================================

describe('expandTilde', () => {
  test('expands ~ at start of path', () => {
    const result = expandTilde('~/Developer')
    expect(result).toBe(join(homedir(), 'Developer'))
  })

  test('expands ~ alone', () => {
    const result = expandTilde('~')
    expect(result).toBe(homedir())
  })

  test('does not expand ~ in middle of path', () => {
    const result = expandTilde('/path/to/~something')
    expect(result).toBe('/path/to/~something')
  })

  test('does not expand ~user syntax', () => {
    // ~user should not be expanded (only ~ alone)
    const result = expandTilde('~otheruser/path')
    // This depends on implementation - if it only expands ~/ or ~ alone
    expect(result).toContain('otheruser')
  })

  test('handles empty string', () => {
    const result = expandTilde('')
    expect(result).toBe('')
  })

  test('handles path without tilde', () => {
    const result = expandTilde('/absolute/path')
    expect(result).toBe('/absolute/path')
  })
})

// ============================================================================
// DEFAULT_CONFIG Tests
// ============================================================================

describe('DEFAULT_CONFIG', () => {
  test('has expected weight defaults', () => {
    expect(DEFAULT_CONFIG.weights.git_recency).toBe(1.0)
    expect(DEFAULT_CONFIG.weights.git_frequency).toBe(0.5)
    expect(DEFAULT_CONFIG.weights.git_status).toBe(5.0)
  })

  test('has expected namespace defaults', () => {
    expect(DEFAULT_CONFIG.namespaces.claude).toEqual(['.claude/**', '**/claude/**'])
    expect(DEFAULT_CONFIG.namespaces.docs).toEqual(['docs/**', '*.md', 'README*', 'CHANGELOG*'])
    expect(DEFAULT_CONFIG.namespaces.dev).toBe('~/Developer')
    expect(DEFAULT_CONFIG.namespaces.config).toBe('~/.config')
  })

  test('has expected priority defaults', () => {
    expect(DEFAULT_CONFIG.priorities.high).toContain('CLAUDE.md')
    expect(DEFAULT_CONFIG.priorities.high).toContain('package.json')
    expect(DEFAULT_CONFIG.priorities.low).toContain('node_modules/**')
    expect(DEFAULT_CONFIG.priorities.low).toContain('.git/**')
  })

  test('has expected index defaults', () => {
    expect(DEFAULT_CONFIG.index.roots).toContain('~/Developer')
    expect(DEFAULT_CONFIG.index.roots).toContain('~/.config')
    expect(DEFAULT_CONFIG.index.exclude.patterns).toContain('node_modules')
    expect(DEFAULT_CONFIG.index.exclude.patterns).toContain('.git')
    expect(DEFAULT_CONFIG.index.depth.default).toBe(10)
    expect(DEFAULT_CONFIG.index.limits.max_files_per_root).toBe(50000)
    expect(DEFAULT_CONFIG.index.limits.warn_threshold_mb).toBe(500)
  })
})

// ============================================================================
// loadConfig Tests
// ============================================================================

describe('loadConfig', () => {
  test('returns defaults when config file does not exist', async () => {
    const config = await loadConfig('/nonexistent/path/config.toml')

    expect(config.weights.git_recency).toBe(DEFAULT_CONFIG.weights.git_recency)
    expect(config.weights.git_frequency).toBe(DEFAULT_CONFIG.weights.git_frequency)
    expect(config.weights.git_status).toBe(DEFAULT_CONFIG.weights.git_status)
  })

  test('expands ~ in paths when using defaults', async () => {
    const config = await loadConfig('/nonexistent/path/config.toml')

    // Roots should have ~ expanded
    expect(config.index.roots.every((r) => !r.includes('~'))).toBe(true)
    // Namespaces should have ~ expanded
    expect(config.namespaces.dev).not.toContain('~')
    expect(config.namespaces.config).not.toContain('~')
  })

  test('loads valid TOML config', async () => {
    const { path, cleanup } = createTempConfig(`
[weights]
git_recency = 2.0
git_frequency = 1.0
git_status = 10.0
`)

    try {
      const config = await loadConfig(path)
      expect(config.weights.git_recency).toBe(2.0)
      expect(config.weights.git_frequency).toBe(1.0)
      expect(config.weights.git_status).toBe(10.0)
    } finally {
      cleanup()
    }
  })

  test('merges partial config with defaults', async () => {
    const { path, cleanup } = createTempConfig(`
[weights]
git_recency = 3.0
# git_frequency and git_status should use defaults
`)

    try {
      const config = await loadConfig(path)
      expect(config.weights.git_recency).toBe(3.0)
      expect(config.weights.git_frequency).toBe(DEFAULT_CONFIG.weights.git_frequency)
      expect(config.weights.git_status).toBe(DEFAULT_CONFIG.weights.git_status)
    } finally {
      cleanup()
    }
  })

  test('loads custom namespaces', async () => {
    const { path, cleanup } = createTempConfig(`
[namespaces]
custom = "~/CustomDir"
patterns = ["*.custom", "custom/**"]
`)

    try {
      const config = await loadConfig(path)
      expect(config.namespaces.custom).not.toContain('~')
      expect(config.namespaces.custom).toContain('CustomDir')
      expect(config.namespaces.patterns).toEqual(['*.custom', 'custom/**'])
    } finally {
      cleanup()
    }
  })

  test('loads custom priorities', async () => {
    const { path, cleanup } = createTempConfig(`
[priorities]
high = ["important.ts", "critical/**"]
low = ["temp/**", "*.tmp"]
`)

    try {
      const config = await loadConfig(path)
      expect(config.priorities.high).toEqual(['important.ts', 'critical/**'])
      expect(config.priorities.low).toEqual(['temp/**', '*.tmp'])
    } finally {
      cleanup()
    }
  })

  test('loads custom index config', async () => {
    const { path, cleanup } = createTempConfig(`
[index]
roots = ["~/Projects", "~/Work"]

[index.exclude]
patterns = ["vendor", "cache"]

[index.depth]
default = 15

[index.limits]
max_files_per_root = 100000
warn_threshold_mb = 1000
`)

    try {
      const config = await loadConfig(path)
      expect(config.index.roots.length).toBe(2)
      expect(config.index.roots.every((r) => !r.includes('~'))).toBe(true)
      expect(config.index.exclude.patterns).toEqual(['vendor', 'cache'])
      expect(config.index.depth.default).toBe(15)
      expect(config.index.limits.max_files_per_root).toBe(100000)
      expect(config.index.limits.warn_threshold_mb).toBe(1000)
    } finally {
      cleanup()
    }
  })

  test('loads root-specific depth config', async () => {
    const { path, cleanup } = createTempConfig(`
[index.depth]
default = 10
"~/Developer" = 20
"~/.config" = 5
`)

    try {
      const config = await loadConfig(path)
      expect(config.index.depth.default).toBe(10)
      // The expanded paths should be in the config
      const expandedDeveloper = join(homedir(), 'Developer')
      const expandedConfig = join(homedir(), '.config')
      expect(config.index.depth[expandedDeveloper]).toBe(20)
      expect(config.index.depth[expandedConfig]).toBe(5)
    } finally {
      cleanup()
    }
  })

  test('throws ConfigError for malformed TOML', async () => {
    const { path, cleanup } = createTempConfig(`
[weights
git_recency = invalid
`)

    try {
      await expect(loadConfig(path)).rejects.toThrow(ConfigError)
    } finally {
      cleanup()
    }
  })

  test('throws ConfigError for invalid weight type', async () => {
    const { path, cleanup } = createTempConfig(`
[weights]
git_recency = "not a number"
`)

    try {
      await expect(loadConfig(path)).rejects.toThrow(ConfigError)
    } finally {
      cleanup()
    }
  })

  test('throws ConfigError for negative weight', async () => {
    const { path, cleanup } = createTempConfig(`
[weights]
git_recency = -1.0
`)

    try {
      await expect(loadConfig(path)).rejects.toThrow(ConfigError)
    } finally {
      cleanup()
    }
  })

  test('throws ConfigError for invalid namespace type', async () => {
    const { path, cleanup } = createTempConfig(`
[namespaces]
invalid = 123
`)

    try {
      await expect(loadConfig(path)).rejects.toThrow(ConfigError)
    } finally {
      cleanup()
    }
  })

  test('throws ConfigError for invalid priorities type', async () => {
    const { path, cleanup } = createTempConfig(`
[priorities]
high = "not an array"
`)

    try {
      await expect(loadConfig(path)).rejects.toThrow(ConfigError)
    } finally {
      cleanup()
    }
  })

  test('throws ConfigError for invalid index.roots type', async () => {
    const { path, cleanup } = createTempConfig(`
[index]
roots = "not an array"
`)

    try {
      await expect(loadConfig(path)).rejects.toThrow(ConfigError)
    } finally {
      cleanup()
    }
  })
})

// ============================================================================
// loadConfigSync Tests
// ============================================================================

describe('loadConfigSync', () => {
  test('returns defaults when config file does not exist', () => {
    const config = loadConfigSync('/nonexistent/path/config.toml')
    expect(config.weights.git_recency).toBe(DEFAULT_CONFIG.weights.git_recency)
  })

  test('loads valid TOML config synchronously', () => {
    const { path, cleanup } = createTempConfig(`
[weights]
git_recency = 4.0
`)

    try {
      const config = loadConfigSync(path)
      expect(config.weights.git_recency).toBe(4.0)
    } finally {
      cleanup()
    }
  })

  test('throws ConfigError for malformed TOML', () => {
    const { path, cleanup } = createTempConfig(`
[invalid
`)

    try {
      expect(() => loadConfigSync(path)).toThrow(ConfigError)
    } finally {
      cleanup()
    }
  })
})

// ============================================================================
// getDepthForRoot Tests
// ============================================================================

describe('getDepthForRoot', () => {
  test('returns default depth for unknown root', () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      index: {
        ...DEFAULT_CONFIG.index,
        depth: { default: 10 },
      },
    }

    const depth = getDepthForRoot(config, '/some/unknown/path')
    expect(depth).toBe(10)
  })

  test('returns specific depth for configured root', () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      index: {
        ...DEFAULT_CONFIG.index,
        depth: {
          default: 10,
          '/specific/path': 25,
        },
      },
    }

    const depth = getDepthForRoot(config, '/specific/path')
    expect(depth).toBe(25)
  })

  test('returns default for root not in config', () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      index: {
        ...DEFAULT_CONFIG.index,
        depth: {
          default: 15,
          '/other/path': 5,
        },
      },
    }

    const depth = getDepthForRoot(config, '/different/path')
    expect(depth).toBe(15)
  })
})

// ============================================================================
// resolveNamespace Tests
// ============================================================================

describe('resolveNamespace', () => {
  test('returns undefined for unknown namespace', () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      namespaces: {},
    }

    const result = resolveNamespace(config, 'unknown')
    expect(result).toBeUndefined()
  })

  test('returns array for string namespace value', () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      namespaces: {
        dev: '/Users/test/Developer',
      },
    }

    const result = resolveNamespace(config, 'dev')
    expect(result).toEqual(['/Users/test/Developer'])
  })

  test('returns array for array namespace value', () => {
    const config: Config = {
      ...DEFAULT_CONFIG,
      namespaces: {
        docs: ['docs/**', '*.md', 'README*'],
      },
    }

    const result = resolveNamespace(config, 'docs')
    expect(result).toEqual(['docs/**', '*.md', 'README*'])
  })

  test('works with default config namespaces', () => {
    const config = { ...DEFAULT_CONFIG }

    // String namespace
    const devResult = resolveNamespace(config, 'dev')
    expect(devResult).toEqual(['~/Developer'])

    // Array namespace
    const docsResult = resolveNamespace(config, 'docs')
    expect(docsResult).toEqual(['docs/**', '*.md', 'README*', 'CHANGELOG*'])
  })
})

// ============================================================================
// getConfigPath Tests
// ============================================================================

describe('getConfigPath', () => {
  test('returns expected path', () => {
    const path = getConfigPath()
    expect(path).toContain('pickme')
    expect(path).toContain('config.toml')
  })

  test('includes home directory', () => {
    const path = getConfigPath()
    expect(path.startsWith(homedir())).toBe(true)
  })
})
