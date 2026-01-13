/**
 * Tests for prefix parsing module.
 */
import { describe, expect, test } from 'bun:test'
import type { Config } from './config'
import { parseQuery, resolvePrefix, type Prefix, type ParseResult } from './prefix'

// Test config with sample namespaces
const testConfig: Config = {
  active: true,
  weights: { git_recency: 1.0, git_frequency: 0.5, git_status: 5.0 },
  namespaces: {
    claude: ['.claude/**', '**/claude/**'],
    docs: ['docs/**', '*.md', 'README*'],
    dev: '~/Developer',
    config: '~/.config',
  },
  priorities: { high: [], low: [] },
  index: {
    roots: [],
    disabled: [],
    include_hidden: false,
    exclude: { patterns: [], gitignored_files: false },
    include: { patterns: [] },
    depth: { default: 10 },
    limits: { max_files_per_root: 50000, warn_threshold_mb: 500 },
  },
}

describe('parseQuery', () => {
  describe('escape sequence (@@)', () => {
    test('converts @@ to literal @', () => {
      const result = parseQuery('@@types', testConfig)
      expect(result.prefix).toBeNull()
      expect(result.searchQuery).toBe('@types')
    })

    test('handles @@ with more text after', () => {
      const result = parseQuery('@@scope/package', testConfig)
      expect(result.prefix).toBeNull()
      expect(result.searchQuery).toBe('@scope/package')
    })

    test('handles just @@', () => {
      const result = parseQuery('@@', testConfig)
      expect(result.prefix).toBeNull()
      expect(result.searchQuery).toBe('@')
    })
  })

  describe('quoted query (@"..." / @\'...\')', () => {
    test('parses double-quoted query as literal', () => {
      const result = parseQuery('@"My File"', testConfig)
      expect(result.prefix).toBeNull()
      expect(result.searchQuery).toBe('My File')
    })

    test('parses single-quoted query as literal', () => {
      const result = parseQuery("@'My File'", testConfig)
      expect(result.prefix).toBeNull()
      expect(result.searchQuery).toBe('My File')
    })

    test('strips quotes after namespace', () => {
      const result = parseQuery('@docs:"My File"', testConfig)
      expect(result.prefix).toEqual({ type: 'namespace', name: 'docs' })
      expect(result.searchQuery).toBe('My File')
    })

    test('strips quotes after folder glob', () => {
      const result = parseQuery('@/components:"My File"', testConfig)
      expect(result.prefix).toEqual({ type: 'folder', folder: 'components' })
      expect(result.searchQuery).toBe('My File')
    })
  })

  describe('namespace without @ (hook input)', () => {
    test('parses namespace without @', () => {
      const result = parseQuery('docs:api', testConfig)
      expect(result.prefix).toEqual({ type: 'namespace', name: 'docs' })
      expect(result.searchQuery).toBe('api')
    })

    test('ignores unknown namespace without @', () => {
      const result = parseQuery('unknown:query', testConfig)
      expect(result.prefix).toBeNull()
      expect(result.searchQuery).toBe('unknown:query')
    })
  })

  describe('folder glob (@/folder:)', () => {
    test('parses single-segment folder', () => {
      const result = parseQuery('@/components:', testConfig)
      expect(result.prefix).toEqual({ type: 'folder', folder: 'components' })
      expect(result.searchQuery).toBe('')
    })

    test('parses folder with search query', () => {
      const result = parseQuery('@/hooks:useAuth', testConfig)
      expect(result.prefix).toEqual({ type: 'folder', folder: 'hooks' })
      expect(result.searchQuery).toBe('useAuth')
    })

    test('parses folder with search query containing spaces', () => {
      const result = parseQuery('@/components:Button Modal', testConfig)
      expect(result.prefix).toEqual({ type: 'folder', folder: 'components' })
      expect(result.searchQuery).toBe('Button Modal')
    })

    test('rejects multi-segment folder paths', () => {
      // @/src/components: has a slash in the folder name, should not be parsed as folder glob
      const result = parseQuery('@/src/components:', testConfig)
      // This should not parse as a folder glob since 'src/components' contains a slash
      expect(result.prefix).toBeNull()
      expect(result.searchQuery).toBe('@/src/components:')
    })

    test('handles folder with dot prefix style', () => {
      const result = parseQuery('@/claude:', testConfig)
      expect(result.prefix).toEqual({ type: 'folder', folder: 'claude' })
      expect(result.searchQuery).toBe('')
    })
  })

  describe('folder shorthand (@folder/)', () => {
    test('parses folder shorthand with trailing slash', () => {
      const result = parseQuery('@components/', testConfig)
      expect(result.prefix).toEqual({ type: 'folder', folder: 'components' })
      expect(result.searchQuery).toBe('')
    })

    test('parses dot folder shorthand', () => {
      const result = parseQuery('@.scratch/', testConfig)
      expect(result.prefix).toEqual({ type: 'folder', folder: '.scratch' })
      expect(result.searchQuery).toBe('')
    })
  })

  describe('folder shorthand with query (@folder/query)', () => {
    test('parses folder shorthand with query', () => {
      const result = parseQuery('@apps/file', testConfig)
      expect(result.prefix).toEqual({ type: 'folder', folder: 'apps' })
      expect(result.searchQuery).toBe('file')
    })

    test('parses folder shorthand with fuzzy query', () => {
      const result = parseQuery('@apps/~file', testConfig)
      expect(result.prefix).toEqual({ type: 'folder', folder: 'apps' })
      expect(result.searchQuery).toBe('~file')
    })
  })

  describe('named namespace (@namespace:)', () => {
    test('parses known namespace', () => {
      const result = parseQuery('@claude:', testConfig)
      expect(result.prefix).toEqual({ type: 'namespace', name: 'claude' })
      expect(result.searchQuery).toBe('')
    })

    test('parses namespace with search query', () => {
      const result = parseQuery('@docs:api', testConfig)
      expect(result.prefix).toEqual({ type: 'namespace', name: 'docs' })
      expect(result.searchQuery).toBe('api')
    })

    test('parses path-based namespace', () => {
      const result = parseQuery('@dev:outfitter', testConfig)
      expect(result.prefix).toEqual({ type: 'namespace', name: 'dev' })
      expect(result.searchQuery).toBe('outfitter')
    })

    test('ignores unknown namespace and treats as plain query', () => {
      const result = parseQuery('@unknown:query', testConfig)
      expect(result.prefix).toBeNull()
      expect(result.searchQuery).toBe('@unknown:query')
    })

    test('handles namespace with empty config', () => {
      const emptyConfig: Config = {
        ...testConfig,
        namespaces: {},
      }
      const result = parseQuery('@claude:query', emptyConfig)
      expect(result.prefix).toBeNull()
      expect(result.searchQuery).toBe('@claude:query')
    })
  })

  describe('inline glob (@*.ext)', () => {
    test('parses extension glob', () => {
      const result = parseQuery('@*.md', testConfig)
      expect(result.prefix).toEqual({ type: 'glob', pattern: '*.md' })
      expect(result.searchQuery).toBe('')
    })

    test('parses TypeScript extension', () => {
      const result = parseQuery('@*.ts', testConfig)
      expect(result.prefix).toEqual({ type: 'glob', pattern: '*.ts' })
      expect(result.searchQuery).toBe('')
    })

    test('parses JSON extension', () => {
      const result = parseQuery('@*.json', testConfig)
      expect(result.prefix).toEqual({ type: 'glob', pattern: '*.json' })
      expect(result.searchQuery).toBe('')
    })

    test('parses multi-part extension', () => {
      const result = parseQuery('@*.test.ts', testConfig)
      expect(result.prefix).toEqual({ type: 'glob', pattern: '*.test.ts' })
      expect(result.searchQuery).toBe('')
    })

    test('handles @* without extension as plain query', () => {
      // @* without a dot after is not a glob pattern
      const result = parseQuery('@*something', testConfig)
      expect(result.prefix).toBeNull()
      expect(result.searchQuery).toBe('@*something')
    })
  })

  describe('no prefix (plain query)', () => {
    test('returns null prefix for plain text', () => {
      const result = parseQuery('src/components', testConfig)
      expect(result.prefix).toBeNull()
      expect(result.searchQuery).toBe('src/components')
    })

    test('returns null prefix for empty string', () => {
      const result = parseQuery('', testConfig)
      expect(result.prefix).toBeNull()
      expect(result.searchQuery).toBe('')
    })

    test('handles query starting with @ but no colon', () => {
      const result = parseQuery('@something', testConfig)
      expect(result.prefix).toBeNull()
      expect(result.searchQuery).toBe('@something')
    })

    test('handles query with @ in middle', () => {
      const result = parseQuery('email@example.com', testConfig)
      expect(result.prefix).toBeNull()
      expect(result.searchQuery).toBe('email@example.com')
    })
  })

  describe('edge cases', () => {
    test('handles @/ without colon', () => {
      const result = parseQuery('@/folder', testConfig)
      expect(result.prefix).toBeNull()
      expect(result.searchQuery).toBe('@/folder')
    })

    test('handles empty folder name @/:', () => {
      // @/: has empty folder name
      const result = parseQuery('@/:', testConfig)
      // colonIdx would be 2, but folder would be empty string
      expect(result.prefix).toBeNull()
      expect(result.searchQuery).toBe('@/:')
    })

    test('prioritizes folder glob over namespace', () => {
      // If there's a namespace called "components", @/components: should still be folder glob
      const configWithComponents: Config = {
        ...testConfig,
        namespaces: {
          ...testConfig.namespaces,
          '/components': ['some-pattern'], // Edge case namespace name
        },
      }
      const result = parseQuery('@/components:', configWithComponents)
      expect(result.prefix).toEqual({ type: 'folder', folder: 'components' })
    })
  })
})

describe('resolvePrefix', () => {
  const context = {
    projectRoot: '/Users/test/project',
    additionalDirs: ['/Users/test/shared'],
  }

  describe('folder prefix', () => {
    test('expands to both normal and dot-prefixed patterns', () => {
      const prefix: Prefix = { type: 'folder', folder: 'components' }
      const result = resolvePrefix(prefix, context, testConfig)
      expect(result.patterns).toEqual(['**/{components,.components}/**/*'])
      expect(result.roots).toBeUndefined()
    })

    test('respects explicit dot folder', () => {
      const prefix: Prefix = { type: 'folder', folder: '.scratch' }
      const result = resolvePrefix(prefix, context, testConfig)
      expect(result.patterns).toEqual(['**/.scratch/**/*'])
    })

    test('handles single-letter folder', () => {
      const prefix: Prefix = { type: 'folder', folder: 'a' }
      const result = resolvePrefix(prefix, context, testConfig)
      expect(result.patterns).toEqual(['**/{a,.a}/**/*'])
    })
  })

  describe('namespace prefix with patterns', () => {
    test('returns configured patterns for pattern namespace', () => {
      const prefix: Prefix = { type: 'namespace', name: 'claude' }
      const result = resolvePrefix(prefix, context, testConfig)
      expect(result.patterns).toEqual(['.claude/**', '**/claude/**'])
      expect(result.roots).toBeUndefined()
    })

    test('returns multiple patterns for docs namespace', () => {
      const prefix: Prefix = { type: 'namespace', name: 'docs' }
      const result = resolvePrefix(prefix, context, testConfig)
      expect(result.patterns).toEqual(['docs/**', '*.md', 'README*'])
    })
  })

  describe('namespace prefix with path', () => {
    test('returns expanded root for path namespace', () => {
      const prefix: Prefix = { type: 'namespace', name: 'dev' }
      const result = resolvePrefix(prefix, context, testConfig)
      expect(result.roots).toBeDefined()
      expect(result.roots?.length).toBe(1)
      // Should end with /Developer (the non-~ part of the path)
      expect(result.roots?.[0]).toEndWith('/Developer')
      expect(result.patterns).toBeUndefined()
    })

    test('expands ~ in path', () => {
      const prefix: Prefix = { type: 'namespace', name: 'config' }
      const result = resolvePrefix(prefix, context, testConfig)
      expect(result.roots).toBeDefined()
      // Should expand ~ to actual home directory
      expect(result.roots?.[0]).not.toContain('~')
      expect(result.roots?.[0]).toEndWith('/.config')
    })
  })

  describe('glob prefix', () => {
    test('returns glob pattern for file extension', () => {
      const prefix: Prefix = { type: 'glob', pattern: '*.md' }
      const result = resolvePrefix(prefix, context, testConfig)
      expect(result.patterns).toEqual(['**/*.md'])
    })

    test('wraps pattern with **/ prefix', () => {
      const prefix: Prefix = { type: 'glob', pattern: '*.ts' }
      const result = resolvePrefix(prefix, context, testConfig)
      expect(result.patterns).toEqual(['**/*.ts'])
    })

    test('handles complex extension patterns', () => {
      const prefix: Prefix = { type: 'glob', pattern: '*.test.ts' }
      const result = resolvePrefix(prefix, context, testConfig)
      expect(result.patterns).toEqual(['**/*.test.ts'])
    })
  })

  describe('error handling', () => {
    test('throws for unknown namespace', () => {
      const prefix: Prefix = { type: 'namespace', name: 'nonexistent' }
      expect(() => resolvePrefix(prefix, context, testConfig)).toThrow()
    })
  })
})
