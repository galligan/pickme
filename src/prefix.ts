/**
 * Prefix parsing module for Claude Code file picker.
 *
 * Handles three types of prefixes:
 * - Named namespaces: @namespace: (looked up in config)
 * - Folder globs: @/folder: (matches folder/ and .folder/)
 * - Inline globs: @*.ext (filter by file extension)
 *
 * @module prefix
 */
import type { Config, NamespaceValue } from './config'
import { expandTilde } from './utils'

/**
 * Represents a parsed prefix type.
 */
export type Prefix =
  | { type: 'namespace'; name: string }
  | { type: 'folder'; folder: string }
  | { type: 'glob'; pattern: string }

/**
 * Result of parsing a query string.
 */
export interface ParseResult {
  /** Parsed prefix, or null if no prefix detected */
  prefix: Prefix | null
  /** Remaining search query after prefix is extracted */
  searchQuery: string
}

/**
 * Context for resolving prefixes to path filters.
 */
export interface ResolveContext {
  /** Current project root directory */
  projectRoot: string
  /** Additional directories from settings */
  additionalDirs: readonly string[]
}

/**
 * Result of resolving a prefix to path filters.
 */
export interface ResolveResult {
  /** Glob patterns to filter results (mutually exclusive with roots) */
  patterns?: readonly string[]
  /** Root directories to search (for path-based namespaces) */
  roots?: readonly string[]
}

/**
 * Parses a query string to extract prefix and search query.
 *
 * Parsing priority:
 * 1. Escape sequence: @@ -> literal @
 * 2. Folder glob: @/folder: (single-segment only)
 * 3. Named namespace: @namespace: (must exist in config)
 * 4. Inline glob: @*.ext
 * 5. No prefix -> null with full query
 *
 * @param query - Raw query string from user input
 * @param config - Configuration containing namespace definitions
 * @returns Parsed prefix and remaining search query
 *
 * @example
 * // Escape sequence
 * parseQuery('@@types', config)
 * // => { prefix: null, searchQuery: '@types' }
 *
 * @example
 * // Folder glob
 * parseQuery('@/components:Button', config)
 * // => { prefix: { type: 'folder', folder: 'components' }, searchQuery: 'Button' }
 *
 * @example
 * // Named namespace
 * parseQuery('@docs:api', config)
 * // => { prefix: { type: 'namespace', name: 'docs' }, searchQuery: 'api' }
 *
 * @example
 * // Inline glob
 * parseQuery('@*.md', config)
 * // => { prefix: { type: 'glob', pattern: '*.md' }, searchQuery: '' }
 */
export function parseQuery(query: string, config: Config): ParseResult {
  // 1. Escape sequence: @@ -> literal @
  if (query.startsWith('@@')) {
    return { prefix: null, searchQuery: query.slice(1) }
  }

  // 2. Folder glob: @/folder: (single segment only)
  if (query.startsWith('@/')) {
    const colonIdx = query.indexOf(':')
    if (colonIdx > 2) {
      const folder = query.slice(2, colonIdx)
      // Validate single segment (no slashes) and non-empty
      if (folder.length > 0 && !folder.includes('/')) {
        return {
          prefix: { type: 'folder', folder },
          searchQuery: query.slice(colonIdx + 1),
        }
      }
    }
    // Invalid folder glob format, fall through to check other patterns
  }

  // 3. Named namespace: @namespace:
  if (query.startsWith('@') && query.includes(':')) {
    const colonIdx = query.indexOf(':')
    const name = query.slice(1, colonIdx)
    // Only parse as namespace if it exists in config and name is valid
    if (name.length > 0 && !name.startsWith('/') && name in config.namespaces) {
      return {
        prefix: { type: 'namespace', name },
        searchQuery: query.slice(colonIdx + 1),
      }
    }
  }

  // 4. Inline glob: @*.ext
  if (query.startsWith('@*.')) {
    const pattern = query.slice(1) // "*.md"
    return {
      prefix: { type: 'glob', pattern },
      searchQuery: '',
    }
  }

  // 5. No prefix - return full query
  return { prefix: null, searchQuery: query }
}


/**
 * Determines if a namespace value is a path (string) or pattern array.
 *
 * @param value - Namespace configuration value
 * @returns True if value is a path string (starts with ~ or /)
 */
function isPathNamespace(value: NamespaceValue): value is string {
  if (typeof value !== 'string') {
    return false
  }
  // Path namespaces start with ~ or / (absolute path)
  return value.startsWith('~') || value.startsWith('/')
}

/**
 * Resolves a prefix to path filters for searching.
 *
 * @param prefix - Parsed prefix to resolve
 * @param context - Resolution context with project root and additional dirs
 * @param config - Configuration containing namespace definitions
 * @returns Patterns or roots to apply as filters
 *
 * @throws {Error} If namespace is not found in config
 *
 * @example
 * // Folder prefix expands to match both normal and dot-prefixed folders
 * resolvePrefix({ type: 'folder', folder: 'components' }, context, config)
 * // => { patterns: ['** /{components,.components}/** /*'] }
 *
 * @example
 * // Pattern namespace returns configured patterns
 * resolvePrefix({ type: 'namespace', name: 'docs' }, context, config)
 * // => { patterns: ['docs/**', '*.md', 'README*'] }
 *
 * @example
 * // Path namespace returns expanded root
 * resolvePrefix({ type: 'namespace', name: 'dev' }, context, config)
 * // => { roots: ['/Users/name/Developer'] }
 *
 * @example
 * // Glob prefix wraps pattern with ** /
 * resolvePrefix({ type: 'glob', pattern: '*.md' }, context, config)
 * // => { patterns: ['** /*.md'] }
 */
export function resolvePrefix(
  prefix: Prefix,
  context: ResolveContext,
  config: Config,
): ResolveResult {
  switch (prefix.type) {
    case 'folder': {
      // Expand @/folder: to match both folder/ and .folder/ anywhere in tree
      const { folder } = prefix
      return {
        patterns: [`**/{${folder},.${folder}}/**/*`],
      }
    }

    case 'namespace': {
      const value = config.namespaces[prefix.name]
      if (value === undefined) {
        throw new Error(`Unknown namespace: ${prefix.name}`)
      }

      if (isPathNamespace(value)) {
        // Path namespace - change search root to expanded absolute path
        return {
          roots: [expandTilde(value)],
        }
      }

      // Pattern namespace - return patterns as-is
      return {
        patterns: [...value],
      }
    }

    case 'glob': {
      // Inline glob - wrap with **/ to match anywhere in tree
      return {
        patterns: [`**/${prefix.pattern}`],
      }
    }
  }
}
