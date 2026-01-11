/**
 * Configuration loading and validation for the pickme file picker.
 *
 * Loads TOML configuration from $XDG_CONFIG_HOME/pickme/config.toml,
 * validates the schema, expands paths, and provides sensible defaults.
 *
 * @module config
 */

import { join } from 'node:path'
import TOML from 'toml'
import { ConfigError } from './errors'
import { expandTilde, getConfigDir } from './utils'

// Re-export expandTilde for backwards compatibility
export { expandTilde } from './utils'

// ============================================================================
// Configuration Types
// ============================================================================

/**
 * Frecency weight multipliers for ranking search results.
 */
export interface WeightsConfig {
  /** Weight for recent git commits (exponential decay). Default: 1.0 */
  readonly git_recency: number
  /** Weight for frequently committed files. Default: 0.5 */
  readonly git_frequency: number
  /** Weight for currently modified files (git status). Default: 5.0 */
  readonly git_status: number
}

/**
 * Namespace definition - either a path or array of glob patterns.
 *
 * @example
 * // Path namespace - changes root directory
 * "~/Developer"
 *
 * @example
 * // Pattern namespace - filters within project
 * ["docs/**", "*.md", "README*"]
 */
export type NamespaceValue = string | readonly string[]

/**
 * Named namespace definitions for quick filtering.
 * Values can be a single glob pattern or an array of patterns.
 */
export interface NamespacesConfig {
  readonly [name: string]: NamespaceValue
}

/**
 * Priority patterns for boosting or penalizing files in results.
 */
export interface PrioritiesConfig {
  /** Patterns to boost in results (e.g., "CLAUDE.md", "src/**") */
  readonly high: readonly string[]
  /** Patterns to penalize in results (e.g., "node_modules/**") */
  readonly low: readonly string[]
}

/**
 * Depth configuration per root directory.
 * Keys are root paths (with ~ expanded), values are max depth.
 */
export interface DepthConfig {
  /** Default depth for roots not explicitly configured. Default: 10 */
  readonly default: number
  readonly [root: string]: number
}

/**
 * Performance limits for indexing operations.
 */
export interface IndexLimitsConfig {
  /** Maximum files to index per root. Default: 50000 */
  readonly max_files_per_root: number
  /** Warn when directory size exceeds this (MB). Default: 500 */
  readonly warn_threshold_mb: number
}

/**
 * Exclusion patterns for indexing.
 */
export interface ExcludeConfig {
  /** Glob patterns to exclude from indexing. */
  readonly patterns: readonly string[]
}

/**
 * Index configuration for directory scanning.
 */
export interface IndexConfig {
  /** Root directories to include in global index. */
  readonly roots: readonly string[]
  /** Exclusion patterns applied globally. */
  readonly exclude: ExcludeConfig
  /** Max depth per root directory. */
  readonly depth: DepthConfig
  /** Performance limits. */
  readonly limits: IndexLimitsConfig
}

/**
 * Complete file picker configuration.
 */
export interface Config {
  /** Frecency weight multipliers. */
  readonly weights: WeightsConfig
  /** Named namespace definitions. */
  readonly namespaces: NamespacesConfig
  /** Priority patterns for ranking. */
  readonly priorities: PrioritiesConfig
  /** Index configuration. */
  readonly index: IndexConfig
}

// ============================================================================
// Default Configuration
// ============================================================================

/**
 * Default configuration used when config file is missing or incomplete.
 * These values align with the spec's recommended defaults.
 */
export const DEFAULT_CONFIG: Config = {
  weights: {
    git_recency: 1.0,
    git_frequency: 0.5,
    git_status: 5.0,
  },
  namespaces: {
    claude: ['.claude/**', '**/claude/**'],
    docs: ['docs/**', '*.md', 'README*', 'CHANGELOG*'],
    dev: '~/Developer',
    config: '~/.config',
  },
  priorities: {
    high: [
      'CLAUDE.md',
      'package.json',
      'Cargo.toml',
      '*.ts',
      '*.tsx',
      'src/**',
    ],
    low: [
      'node_modules/**',
      'dist/**',
      'build/**',
      '*.lock',
      '.git/**',
      '*.min.js',
    ],
  },
  index: {
    roots: ['~/Developer', '~/.config'],
    exclude: {
      patterns: [
        'node_modules',
        '.git',
        'dist',
        'build',
        '.next',
        'target',
        '__pycache__',
        '*.pyc',
      ],
    },
    depth: {
      default: 10,
    },
    limits: {
      max_files_per_root: 50000,
      warn_threshold_mb: 500,
    },
  },
} as const

// ============================================================================
// Path Utilities
// ============================================================================

/**
 * Expands ~ in namespace values.
 */
function expandNamespaces(namespaces: NamespacesConfig): NamespacesConfig {
  const result: Record<string, NamespaceValue> = {}
  for (const [name, value] of Object.entries(namespaces)) {
    if (typeof value === 'string') {
      result[name] = expandTilde(value)
    } else {
      result[name] = value.map(expandTilde)
    }
  }
  return result
}

/**
 * Creates a copy of the default config with all ~ paths expanded.
 */
function getExpandedDefaults(): Config {
  return {
    weights: { ...DEFAULT_CONFIG.weights },
    namespaces: expandNamespaces(DEFAULT_CONFIG.namespaces),
    priorities: { ...DEFAULT_CONFIG.priorities },
    index: {
      roots: DEFAULT_CONFIG.index.roots.map(expandTilde),
      exclude: { patterns: [...DEFAULT_CONFIG.index.exclude.patterns] },
      depth: { ...DEFAULT_CONFIG.index.depth },
      limits: { ...DEFAULT_CONFIG.index.limits },
    },
  }
}

// ============================================================================
// Configuration Loading
// ============================================================================

/** Default config file path (uses XDG Base Directory Specification) */
const CONFIG_PATH = join(getConfigDir(), 'config.toml')

/**
 * Raw TOML structure before validation.
 * Uses unknown for flexible parsing before type narrowing.
 */
interface RawConfig {
  weights?: Partial<WeightsConfig>
  namespaces?: Record<string, string | string[]>
  priorities?: Partial<PrioritiesConfig>
  index?: {
    roots?: string[]
    exclude?: { patterns?: string[] }
    depth?: Record<string, number>
    limits?: Partial<IndexLimitsConfig>
  }
}

/**
 * Validates and merges weights configuration with defaults.
 */
function validateWeights(raw: Partial<WeightsConfig> | undefined): WeightsConfig {
  const defaults = DEFAULT_CONFIG.weights
  return {
    git_recency: validateNumber(raw?.git_recency, defaults.git_recency, 'weights.git_recency'),
    git_frequency: validateNumber(raw?.git_frequency, defaults.git_frequency, 'weights.git_frequency'),
    git_status: validateNumber(raw?.git_status, defaults.git_status, 'weights.git_status'),
  }
}

/**
 * Validates a numeric value with range checking.
 */
function validateNumber(value: unknown, defaultValue: number, field: string): number {
  if (value === undefined || value === null) {
    return defaultValue
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw ConfigError.validationError(`${field} must be a finite number`)
  }
  if (value < 0) {
    throw ConfigError.validationError(`${field} must be non-negative`)
  }
  return value
}

/**
 * Validates namespace configuration.
 * Expands ~ in all path patterns.
 */
function validateNamespaces(raw: Record<string, string | string[]> | undefined): NamespacesConfig {
  if (!raw) {
    return expandNamespaces(DEFAULT_CONFIG.namespaces)
  }

  const result: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      result[name] = expandTilde(value)
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      result[name] = value.map(expandTilde)
    } else {
      throw ConfigError.validationError(
        `namespaces.${name} must be a string or array of strings`
      )
    }
  }
  return result
}

/**
 * Validates priorities configuration.
 */
function validatePriorities(raw: Partial<PrioritiesConfig> | undefined): PrioritiesConfig {
  const defaults = DEFAULT_CONFIG.priorities
  return {
    high: validateStringArray(raw?.high, defaults.high, 'priorities.high'),
    low: validateStringArray(raw?.low, defaults.low, 'priorities.low'),
  }
}

/**
 * Validates a string array value.
 */
function validateStringArray(
  value: unknown,
  defaultValue: readonly string[],
  field: string
): readonly string[] {
  if (value === undefined || value === null) {
    return defaultValue
  }
  if (!Array.isArray(value)) {
    throw ConfigError.validationError(`${field} must be an array`)
  }
  if (!value.every((v) => typeof v === 'string')) {
    throw ConfigError.validationError(`${field} must contain only strings`)
  }
  return value as string[]
}

/**
 * Validates index configuration.
 * Expands ~ in all root paths.
 */
function validateIndex(raw: RawConfig['index'] | undefined): IndexConfig {
  const defaults = DEFAULT_CONFIG.index

  // Validate and expand roots
  const rawRoots = raw?.roots ?? defaults.roots
  if (!Array.isArray(rawRoots) || !rawRoots.every((v) => typeof v === 'string')) {
    throw ConfigError.validationError('index.roots must be an array of strings')
  }
  const roots = rawRoots.map(expandTilde)

  // Validate exclude patterns
  const rawPatterns = raw?.exclude?.patterns ?? defaults.exclude.patterns
  const patterns = validateStringArray(rawPatterns, defaults.exclude.patterns, 'index.exclude.patterns')

  // Validate depth configuration
  const rawDepth = raw?.depth ?? {}
  const depth: Record<string, number> = {
    default: validateNumber(rawDepth.default, defaults.depth.default, 'index.depth.default'),
  }

  for (const [key, value] of Object.entries(rawDepth)) {
    if (key === 'default') continue
    const expandedKey = expandTilde(key)
    depth[expandedKey] = validateNumber(value, defaults.depth.default, `index.depth["${key}"]`)
  }

  // Validate limits
  const rawLimits = raw?.limits ?? {}
  const limits: IndexLimitsConfig = {
    max_files_per_root: validateNumber(
      rawLimits.max_files_per_root,
      defaults.limits.max_files_per_root,
      'index.limits.max_files_per_root'
    ),
    warn_threshold_mb: validateNumber(
      rawLimits.warn_threshold_mb,
      defaults.limits.warn_threshold_mb,
      'index.limits.warn_threshold_mb'
    ),
  }

  return {
    roots,
    exclude: { patterns },
    depth: depth as DepthConfig,
    limits,
  }
}

/**
 * Validates raw TOML config and returns a fully typed Config object.
 * Merges with defaults for any missing values.
 */
function validateConfig(raw: unknown): Config {
  if (raw !== null && typeof raw === 'object') {
    const rawConfig = raw as RawConfig
    return {
      weights: validateWeights(rawConfig.weights),
      namespaces: validateNamespaces(rawConfig.namespaces),
      priorities: validatePriorities(rawConfig.priorities),
      index: validateIndex(rawConfig.index),
    }
  }
  // Empty or invalid config, use all defaults
  return getExpandedDefaults()
}

/**
 * Loads configuration from the TOML file.
 *
 * If the config file doesn't exist, returns sensible defaults.
 * If the config file is malformed, throws a ConfigError.
 * Missing values are filled with defaults.
 *
 * @param configPath - Optional custom config path (for testing)
 * @returns Fully validated Config object with ~ expanded in paths
 *
 * @example
 * ```ts
 * const config = await loadConfig()
 * console.log(config.weights.git_recency) // 1.0
 * console.log(config.namespaces.dev) // "/Users/you/Developer"
 * ```
 */
export async function loadConfig(configPath: string = CONFIG_PATH): Promise<Config> {
  try {
    const file = Bun.file(configPath)
    const exists = await file.exists()

    if (!exists) {
      // No config file, use defaults with expanded paths
      return getExpandedDefaults()
    }

    const content = await file.text()
    const raw = TOML.parse(content) as unknown

    return validateConfig(raw)
  } catch (err) {
    // TOML parse errors
    if (err instanceof Error && err.message.includes('parse')) {
      throw ConfigError.parseError(configPath, err)
    }
    // Re-throw ConfigErrors as-is
    if (err instanceof ConfigError) {
      throw err
    }
    // Wrap unknown errors
    throw ConfigError.parseError(configPath, err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * Synchronously loads configuration (for use in scripts).
 *
 * Note: Prefer the async `loadConfig()` in most cases.
 *
 * @param configPath - Optional custom config path (for testing)
 * @returns Fully validated Config object with ~ expanded in paths
 */
export function loadConfigSync(configPath: string = CONFIG_PATH): Config {
  try {
    const content = require('fs').readFileSync(configPath, 'utf-8') as string
    const raw = TOML.parse(content) as unknown
    return validateConfig(raw)
  } catch (err) {
    // File not found, use defaults
    if (err instanceof Error && 'code' in err && err.code === 'ENOENT') {
      return getExpandedDefaults()
    }
    // TOML parse errors
    if (err instanceof Error && err.message.includes('parse')) {
      throw ConfigError.parseError(configPath, err)
    }
    // Re-throw ConfigErrors as-is
    if (err instanceof ConfigError) {
      throw err
    }
    // Wrap unknown errors
    throw ConfigError.parseError(configPath, err instanceof Error ? err : new Error(String(err)))
  }
}

/**
 * Gets the depth limit for a specific root directory.
 *
 * @param config - The loaded configuration
 * @param root - The root directory path (~ already expanded)
 * @returns The max depth for this root
 */
export function getDepthForRoot(config: Config, root: string): number {
  const specificDepth = config.index.depth[root]
  if (typeof specificDepth === 'number') {
    return specificDepth
  }
  return config.index.depth.default
}

/**
 * Resolves a namespace to its glob patterns.
 *
 * @param config - The loaded configuration
 * @param name - The namespace name (without @ prefix)
 * @returns Array of glob patterns, or undefined if namespace not found
 */
export function resolveNamespace(
  config: Config,
  name: string
): readonly string[] | undefined {
  const value = config.namespaces[name]
  if (value === undefined) {
    return undefined
  }
  if (typeof value === 'string') {
    return [value]
  }
  return value
}

/**
 * Returns the default config path.
 * Useful for tools that want to show users where config is expected.
 */
export function getConfigPath(): string {
  return CONFIG_PATH
}
