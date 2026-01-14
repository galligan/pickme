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
  /** Whether to exclude files matched by .gitignore. Default: false */
  readonly gitignored_files?: boolean
}

/**
 * Inclusion patterns for indexing.
 */
export interface IncludeConfig {
  /** Glob patterns to explicitly include (overrides excludes). */
  readonly patterns: readonly string[]
}

/**
 * Index configuration for directory scanning.
 */
export interface IndexConfig {
  /** Root directories to include in global index. */
  readonly roots: readonly string[]
  /** Specific directories to skip even if under an indexed root. */
  readonly disabled: readonly string[]
  /** Whether to include hidden files/directories (dotfiles). Default: false */
  readonly include_hidden: boolean
  /** Exclusion patterns applied globally. */
  readonly exclude: ExcludeConfig
  /** Inclusion patterns (overrides excludes). */
  readonly include: IncludeConfig
  /** Max depth per root directory. */
  readonly depth: DepthConfig
  /** Performance limits. */
  readonly limits: IndexLimitsConfig
}

/**
 * Complete file picker configuration.
 */
export interface Config {
  /** Whether pickme is active (default: true). */
  readonly active: boolean
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
  active: true,
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
    high: ['CLAUDE.md', 'package.json', 'Cargo.toml', '*.ts', '*.tsx', 'src/**'],
    low: ['node_modules/**', 'dist/**', 'build/**', '*.lock', '.git/**', '*.min.js'],
  },
  index: {
    roots: ['~/Developer', '~/.config'],
    disabled: [],
    include_hidden: false,
    exclude: {
      patterns: [
        // Version control
        '.git',
        '.svn',
        '.hg',
        // Dependencies
        'node_modules',
        'vendor',
        '.pnpm',
        // Build outputs
        'dist',
        'build',
        'out',
        '.next',
        '.nuxt',
        '.output',
        'target',
        // Caches
        '.cache',
        '__pycache__',
        '.pytest_cache',
        '.mypy_cache',
        '.turbo',
        '.parcel-cache',
        // Generated files
        '*.min.js',
        '*.min.css',
        '*.map',
        '*.pyc',
        '*.pyo',
        // Large binaries
        '*.wasm',
        // Temp files
        '.tmp',
        '.temp',
        // OS metadata
        '.DS_Store',
        '.AppleDouble',
        '.LSOverride',
        '._*',
        '.Spotlight-V100',
        '.Trashes',
        '.Trash-*',
        '.fseventsd',
        '.TemporaryItems',
        '.apdisk',
        '.directory',
        '.nfs*',
      ],
      gitignored_files: true,
    },
    include: {
      patterns: [],
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

function dedupeStrings(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value)
      result.push(value)
    }
  }
  return result
}

/**
 * Creates a copy of the default config with all ~ paths expanded.
 */
function getExpandedDefaults(): Config {
  return {
    active: DEFAULT_CONFIG.active,
    weights: { ...DEFAULT_CONFIG.weights },
    namespaces: expandNamespaces(DEFAULT_CONFIG.namespaces),
    priorities: { ...DEFAULT_CONFIG.priorities },
    index: {
      roots: DEFAULT_CONFIG.index.roots.map(expandTilde),
      disabled: DEFAULT_CONFIG.index.disabled.map(expandTilde),
      include_hidden: DEFAULT_CONFIG.index.include_hidden,
      exclude: {
        patterns: [...DEFAULT_CONFIG.index.exclude.patterns],
        gitignored_files: DEFAULT_CONFIG.index.exclude.gitignored_files,
      },
      include: { patterns: [...DEFAULT_CONFIG.index.include.patterns] },
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
  active?: boolean
  weights?: Partial<WeightsConfig>
  namespaces?: Record<string, string | string[]>
  priorities?: Partial<PrioritiesConfig>
  roots?: Array<{
    path?: string
    namespace?: string
    disabled?: boolean
  }>
  excludes?: Array<{
    pattern?: string
  }>
  index?: {
    roots?: string[]
    disabled?: string[]
    exclude?: { patterns?: string[]; gitignored_files?: boolean }
    include?: { patterns?: string[] }
    max_depth?: number
    include_gitignored?: boolean
    include_hidden?: boolean
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
    git_frequency: validateNumber(
      raw?.git_frequency,
      defaults.git_frequency,
      'weights.git_frequency'
    ),
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

function validateBoolean(
  value: unknown,
  defaultValue: boolean | undefined,
  field: string
): boolean | undefined {
  if (value === undefined || value === null) {
    return defaultValue
  }
  if (typeof value !== 'boolean') {
    throw ConfigError.validationError(`${field} must be a boolean`)
  }
  return value
}

function parseRootEntries(rawRoots: RawConfig['roots']): {
  roots: string[]
  disabled: string[]
  namespaces: NamespacesConfig
} | null {
  if (rawRoots === undefined) {
    return null
  }
  if (!Array.isArray(rawRoots)) {
    throw ConfigError.validationError('roots must be an array of tables')
  }

  const roots: string[] = []
  const disabled: string[] = []
  const namespaces: Record<string, NamespaceValue> = {}

  for (const entry of rawRoots) {
    if (!entry || typeof entry !== 'object') {
      throw ConfigError.validationError('roots entries must be tables with a path')
    }
    const path = (entry as { path?: unknown }).path
    const namespace = (entry as { namespace?: unknown }).namespace
    const disabledValue = (entry as { disabled?: unknown }).disabled

    if (typeof path !== 'string' || path.trim().length === 0) {
      throw ConfigError.validationError('roots.path must be a non-empty string')
    }

    const expandedPath = expandTilde(path)
    roots.push(expandedPath)

    if (disabledValue !== undefined) {
      if (typeof disabledValue !== 'boolean') {
        throw ConfigError.validationError('roots.disabled must be a boolean')
      }
      if (disabledValue) {
        disabled.push(expandedPath)
      }
    }

    if (namespace !== undefined) {
      if (typeof namespace !== 'string' || namespace.trim().length === 0) {
        throw ConfigError.validationError('roots.namespace must be a non-empty string')
      }
      namespaces[namespace] = expandedPath
    }
  }

  return {
    roots: dedupeStrings(roots),
    disabled: dedupeStrings(disabled),
    namespaces,
  }
}

function parseExcludeEntries(rawExcludes: RawConfig['excludes']): string[] | null {
  if (rawExcludes === undefined) {
    return null
  }
  if (!Array.isArray(rawExcludes)) {
    throw ConfigError.validationError('excludes must be an array of tables')
  }

  const patterns: string[] = []

  for (const entry of rawExcludes) {
    if (!entry || typeof entry !== 'object') {
      throw ConfigError.validationError('excludes entries must be tables with a pattern')
    }
    const pattern = (entry as { pattern?: unknown }).pattern
    if (typeof pattern !== 'string' || pattern.trim().length === 0) {
      throw ConfigError.validationError('excludes.pattern must be a non-empty string')
    }
    patterns.push(pattern)
  }

  return dedupeStrings(patterns)
}

/**
 * Validates namespace configuration.
 * Expands ~ in all path patterns.
 */
function validateNamespaces(raw: Record<string, string | string[]> | undefined): NamespacesConfig {
  const defaults = expandNamespaces(DEFAULT_CONFIG.namespaces)
  if (!raw || Object.keys(raw).length === 0) {
    return defaults
  }

  const result: Record<string, string | string[]> = { ...defaults }
  for (const [name, value] of Object.entries(raw)) {
    if (typeof value === 'string') {
      result[name] = expandTilde(value)
    } else if (Array.isArray(value) && value.every(v => typeof v === 'string')) {
      result[name] = value.map(expandTilde)
    } else {
      throw ConfigError.validationError(`namespaces.${name} must be a string or array of strings`)
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
  if (!value.every(v => typeof v === 'string')) {
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
  if (!Array.isArray(rawRoots) || !rawRoots.every(v => typeof v === 'string')) {
    throw ConfigError.validationError('index.roots must be an array of strings')
  }
  const roots = rawRoots.map(expandTilde)

  // Validate and expand disabled directories
  const rawDisabled = raw?.disabled ?? defaults.disabled
  if (!Array.isArray(rawDisabled) || !rawDisabled.every(v => typeof v === 'string')) {
    throw ConfigError.validationError('index.disabled must be an array of strings')
  }
  const disabled = rawDisabled.map(expandTilde)

  // Validate exclude patterns
  const rawExcludePatterns = raw?.exclude?.patterns ?? defaults.exclude.patterns
  const excludePatterns = validateStringArray(
    rawExcludePatterns,
    defaults.exclude.patterns,
    'index.exclude.patterns'
  )
  const rawExcludeGitignored = raw?.exclude?.gitignored_files
  const rawIncludeGitignored = raw?.include_gitignored
  let gitignored = defaults.exclude.gitignored_files
  if (rawExcludeGitignored !== undefined) {
    gitignored = validateBoolean(
      rawExcludeGitignored,
      defaults.exclude.gitignored_files,
      'index.exclude.gitignored_files'
    )
  } else if (rawIncludeGitignored !== undefined) {
    const includeGitignored = validateBoolean(
      rawIncludeGitignored,
      !defaults.exclude.gitignored_files,
      'index.include_gitignored'
    )
    gitignored = !includeGitignored
  }
  const includeHidden =
    validateBoolean(raw?.include_hidden, defaults.include_hidden, 'index.include_hidden') ?? false

  // Validate include patterns
  const rawIncludePatterns = raw?.include?.patterns ?? defaults.include.patterns
  const includePatterns = validateStringArray(
    rawIncludePatterns,
    defaults.include.patterns,
    'index.include.patterns'
  )

  // Validate depth configuration
  const rawDepth = raw?.depth ?? {}
  const depthDefaultValue = rawDepth.default ?? raw?.max_depth
  const depth: Record<string, number> = {
    default: validateNumber(
      depthDefaultValue,
      defaults.depth.default,
      rawDepth.default !== undefined ? 'index.depth.default' : 'index.max_depth'
    ),
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
    disabled,
    include_hidden: includeHidden,
    exclude: { patterns: excludePatterns, gitignored_files: gitignored },
    include: { patterns: includePatterns },
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
    const baseConfig: Config = {
      active: validateBoolean(rawConfig.active, true, 'active') ?? true,
      weights: validateWeights(rawConfig.weights),
      namespaces: validateNamespaces(rawConfig.namespaces),
      priorities: validatePriorities(rawConfig.priorities),
      index: validateIndex(rawConfig.index),
    }

    const rootEntries = parseRootEntries(rawConfig.roots)
    const hasRootEntries = rootEntries !== null
    const hasIndexRoots = Array.isArray(rawConfig.index?.roots)
    const hasIndexDisabled = Array.isArray(rawConfig.index?.disabled)

    let namespaces = baseConfig.namespaces
    let roots = baseConfig.index.roots
    let disabled = baseConfig.index.disabled

    if (hasRootEntries && rootEntries) {
      roots = rootEntries.roots
      disabled = rootEntries.disabled
      namespaces = { ...namespaces, ...rootEntries.namespaces }

      if (hasIndexRoots) {
        roots = dedupeStrings([...roots, ...baseConfig.index.roots])
      }
      if (hasIndexDisabled) {
        disabled = dedupeStrings([...disabled, ...baseConfig.index.disabled])
      }
    }

    // Merge exclude patterns from multiple sources (additive, not overwrite):
    // 1. Start with default exclude patterns
    // 2. Add patterns from [[excludes]] array of tables (if present)
    // 3. Add patterns from index.exclude.patterns (if present)
    // All sources are merged together using dedupeStrings to avoid duplicates.
    const excludeEntries = parseExcludeEntries(rawConfig.excludes)
    const hasExcludeEntries = excludeEntries !== null
    const hasIndexExclude = Array.isArray(rawConfig.index?.exclude?.patterns)

    let excludePatterns = baseConfig.index.exclude.patterns
    if (hasExcludeEntries && excludeEntries) {
      excludePatterns = dedupeStrings([...excludePatterns, ...excludeEntries])
    }

    if (hasIndexExclude) {
      excludePatterns = dedupeStrings([...excludePatterns, ...rawConfig.index.exclude.patterns])
    }

    return {
      ...baseConfig,
      namespaces,
      index: {
        ...baseConfig.index,
        roots,
        disabled,
        exclude: {
          ...baseConfig.index.exclude,
          patterns: excludePatterns,
        },
      },
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
export function resolveNamespace(config: Config, name: string): readonly string[] | undefined {
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
