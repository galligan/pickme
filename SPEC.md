# File Picker for Claude Code

## Motivation

Claude Code's built-in `@` file picker uses fast filesystem traversal, but
has limitations in large codebases:

1. **No frecency awareness** — Files you work on frequently are treated the
   same as files you've never touched
2. **No git awareness** — Recently committed or currently modified files
   aren't prioritized
3. **Limited filtering** — No namespaces like `@claude:` or `@docs:` for
   quick access to common locations
4. **No cross-project intelligence** — Each project is isolated; no global
   index of your commonly-used paths
5. **Performance in monorepos** — Large repositories can be slow without
   pre-built indexes

This spec defines a custom file picker that addresses these limitations through:

- A global FTS5-indexed database of file paths
- Frecency scoring based on git history
- Configurable namespaces and priority patterns
- Smart filtering by project context

## Overview

The file picker consists of:

1. **Global SQLite Index** — FTS5-based full-text search across all indexed
   directories
2. **SessionStart Hook** — Refreshes the index and frecency scores at session
   start
3. **Query Client** — Fast lookup script that Claude Code invokes on `@`
   autocomplete
4. **Configuration** — TOML file for weights, namespaces, priorities, and
   index roots

## Platform Support

- **Supported**: macOS, Linux
- **Future**: Windows compatibility planned for Phase 4

## Architecture

```text
┌─────────────────────────────────────────────────────────────────┐
│                 ~/.config/claude/file-picker/                   │
│                                                                 │
│  ┌──────────────┐      ┌─────────────────────────────────────┐ │
│  │ SessionStart │─────▶│ Index Refresh                       │ │
│  │    Hook      │      │  • fd scan of configured roots      │ │
│  └──────────────┘      │  • git log parsing for frecency     │ │
│                        │  • git status for active files      │ │
│                        └───────────────┬─────────────────────┘ │
│                                        ▼                       │
│                        ┌─────────────────────────────────────┐ │
│                        │          index.db (SQLite)          │ │
│                        │  • FTS5 virtual table for paths     │ │
│                        │  • Frecency scores table            │ │
│                        │  • Watched roots metadata           │ │
│                        └───────────────▲─────────────────────┘ │
│                                        │                       │
│  ┌──────────────┐      ┌───────────────┴─────────────────────┐ │
│  │   @ query    │─────▶│ Query Client                        │ │
│  │  (Claude)    │      │  • FTS5 search (pre-indexed)        │ │
│  └──────────────┘      │  • fd --changed-within 24h (fresh)  │ │
│                        │  • Merge, rank, return top 15       │ │
│                        └─────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

## Performance

Benchmarked on macOS with Bun runtime:

| Scenario                                           | Time   |
| -------------------------------------------------- | ------ |
| Bun startup + SQLite open + FTS5 query (10k files) | ~10ms  |
| FTS5 query alone                                   | ~0.5ms |
| Full index build (10k files) + query               | ~40ms  |

The 100ms latency budget is easily achievable without a daemon.

## Database Schema

```sql
-- Enable WAL mode for concurrent reads during index updates
PRAGMA journal_mode = WAL;

-- Metadata table with primary key (source of truth)
CREATE TABLE files_meta (
  path TEXT PRIMARY KEY,             -- Absolute path
  filename TEXT NOT NULL,            -- Basename only
  dir_components TEXT NOT NULL,      -- Space-separated path parts
  root TEXT NOT NULL,                -- Which watched root this belongs to
  mtime INTEGER NOT NULL,            -- File modification time (unix epoch)
  relative_path TEXT                 -- Path relative to root (for display)
);

-- FTS5 index backed by files_meta (external content)
CREATE VIRTUAL TABLE files_fts USING fts5(
  path,
  filename,
  dir_components,
  content=files_meta,
  content_rowid=rowid,
  tokenize='unicode61 remove_diacritics 1 tokenchars _-'
);

-- Triggers to keep FTS in sync with metadata
CREATE TRIGGER files_meta_ai AFTER INSERT ON files_meta BEGIN
  INSERT INTO files_fts(rowid, path, filename, dir_components)
  VALUES (NEW.rowid, NEW.path, NEW.filename, NEW.dir_components);
END;

CREATE TRIGGER files_meta_ad AFTER DELETE ON files_meta BEGIN
  INSERT INTO files_fts(files_fts, rowid, path, filename, dir_components)
  VALUES ('delete', OLD.rowid, OLD.path, OLD.filename, OLD.dir_components);
END;

CREATE TRIGGER files_meta_au AFTER UPDATE ON files_meta BEGIN
  INSERT INTO files_fts(files_fts, rowid, path, filename, dir_components)
  VALUES ('delete', OLD.rowid, OLD.path, OLD.filename, OLD.dir_components);
  INSERT INTO files_fts(rowid, path, filename, dir_components)
  VALUES (NEW.rowid, NEW.path, NEW.filename, NEW.dir_components);
END;

-- Frecency scores for ranking
CREATE TABLE frecency (
  path TEXT PRIMARY KEY REFERENCES files_meta(path) ON DELETE CASCADE,
  git_recency REAL DEFAULT 0,
  git_frequency INTEGER DEFAULT 0,
  git_status_boost REAL DEFAULT 0,
  last_seen INTEGER DEFAULT 0
);

-- Indexed directory roots and their metadata
CREATE TABLE watched_roots (
  root TEXT PRIMARY KEY,
  max_depth INTEGER DEFAULT 10,
  last_indexed INTEGER,
  file_count INTEGER
);

-- Indexes for efficient queries
CREATE INDEX idx_files_meta_root ON files_meta(root);
CREATE INDEX idx_frecency_path ON frecency(path);
```

### Tokenization Notes

We use `unicode61` tokenizer (NOT porter stemmer) because:

- Porter stemmer breaks path prefix matching (`src/comp` would match anywhere)
- `unicode61` preserves exact tokens for path components
- `tokenchars='_-'` keeps underscores and hyphens as part of tokens

For true prefix queries, combine FTS5 with `LIKE`:

```sql
SELECT path FROM files_fts
WHERE files_fts MATCH ? AND path LIKE ? || '%'
ORDER BY rank
```

## Query Scoping

**All queries are project-scoped by default.** Unprefixed queries search:

1. Current project root (`CLAUDE_PROJECT_DIR`)
2. Additional directories from `.claude/settings.json`

To search globally, use a namespace like `@dev:` that points to a broader root.

## Output Paths

Paths are returned in **smart format**:

- **In-project files**: Relative to project root (e.g., `src/components/Button.tsx`)
- **Outside project**: Absolute path (e.g., `~/.config/claude/settings.json`)

```typescript
function formatPath(absolutePath: string, projectRoot: string): string {
  if (absolutePath.startsWith(projectRoot)) {
    return path.relative(projectRoot, absolutePath)
  }
  // Use ~ for home directory
  if (absolutePath.startsWith(os.homedir())) {
    return absolutePath.replace(os.homedir(), '~')
  }
  return absolutePath
}
```

## Query Flow

### Input

Claude Code invokes the file picker with JSON via stdin:

```json
{ "query": "src/comp" }
```

### Processing

```typescript
// Pseudocode — exact implementation may vary

async function suggest(input: { query: string }): Promise<string[]> {
  const context = {
    projectRoot: process.env.CLAUDE_PROJECT_DIR,
    additionalDirs: await getAdditionalDirs(),
  }

  // 1. Parse prefix (namespace, folder glob, or inline glob)
  const { prefix, searchQuery } = parseQuery(input.query)

  // 2. Resolve path filters (always project-scoped unless namespace overrides)
  const pathFilters = resolvePrefix(prefix, context)

  // 3. Search pre-built FTS5 index
  const indexed = await searchFTS5(searchQuery, { pathFilters })

  // 4. Catch new files created in last 24 hours (not yet indexed)
  const fresh = await findRecentFiles(searchQuery, context, '24h')

  // 5. Merge, apply frecency scores, sort
  const ranked = applyFrecencyRanking(merge(indexed, fresh))

  // 6. Apply priority boosts/penalties
  const prioritized = applyPriorityPatterns(ranked)

  // 7. Format paths (relative for in-project, absolute for outside)
  return prioritized.slice(0, 15).map(f => formatPath(f.path, context.projectRoot))
}
```

### Output

Newline-separated file paths to stdout (max 15):

```text
src/components/Button.tsx
src/components/Modal.tsx
~/.config/claude/settings.json
```

## Prefix Syntax

Three distinct prefix types:

### Named Namespaces: `@namespace:`

Pre-defined filter sets from config. Resolved to explicit glob patterns.

| Prefix        | Configured Pattern               | Example Match             |
| ------------- | -------------------------------- | ------------------------- |
| `@claude:`    | `[".claude/**", "**/claude/**"]` | `.claude/settings.json`   |
| `@docs:`      | `["docs/**", "*.md", "README*"]` | `docs/api.md`             |
| `@dev:`       | `"~/Developer"`                  | `~/Developer/project/...` |
| `@outfitter:` | `"~/Developer/outfitter"`        | Custom namespace          |

### Folder Globs: `@/folder:`

Dynamic pattern matching for a **single folder name**. Matches both `folder/`
and `.folder/` variants.

| Prefix          | Expands To                      | Example Match         |
| --------------- | ------------------------------- | --------------------- |
| `@/components:` | `**/{components,.components}/…` | `src/…/Button.tsx`    |
| `@/hooks:`      | `**/{hooks,.hooks}/**/*`        | `lib/.hooks/useAuth…` |
| `@/claude:`     | `**/{claude,.claude}/**/*`      | `.claude/settings.…`  |

**Note**: Only single-segment folder names are supported.
`@/src/components:` is invalid.

### Inline Globs: `@*.ext`

Filter by file extension directly in the query.

| Prefix    | Meaning              | Example Match              |
| --------- | -------------------- | -------------------------- |
| `@*.md`   | All markdown files   | `README.md`, `docs/api.md` |
| `@*.ts`   | All TypeScript files | `src/index.ts`             |
| `@*.json` | All JSON files       | `package.json`             |

### Escaping

Use `@@` to search for a literal `@` character:

- `@@types` searches for files containing `@types`

### Parsing Logic

```typescript
type Prefix =
  | { type: 'namespace'; name: string }
  | { type: 'folder'; folder: string }
  | { type: 'glob'; pattern: string }

function parseQuery(
  query: string
): { prefix: Prefix | null; searchQuery: string } {
  // Escape sequence: @@ -> literal @
  if (query.startsWith('@@')) {
    return { prefix: null, searchQuery: query.slice(1) }
  }

  // Folder glob: @/folder: (single segment only)
  if (query.startsWith('@/')) {
    const colonIdx = query.indexOf(':')
    if (colonIdx > 2) {
      const folder = query.slice(2, colonIdx)
      // Validate single segment (no slashes)
      if (!folder.includes('/')) {
        return {
          prefix: { type: 'folder', folder },
          searchQuery: query.slice(colonIdx + 1),
        }
      }
    }
  }

  // Named namespace: @namespace:
  if (query.startsWith('@') && query.includes(':')) {
    const colonIdx = query.indexOf(':')
    const name = query.slice(1, colonIdx)
    if (config.namespaces[name]) {
      return {
        prefix: { type: 'namespace', name },
        searchQuery: query.slice(colonIdx + 1),
      }
    }
  }

  // Inline glob: @*.ext
  if (query.startsWith('@*.')) {
    const ext = query.slice(2) // "*.md"
    return {
      prefix: { type: 'glob', pattern: ext },
      searchQuery: '',
    }
  }

  // No prefix — search project scope
  return { prefix: null, searchQuery: query }
}
```

## Frecency Scoring

### Formula

```typescript
function calculateScore(path: string, frecency: FrecencyRecord): number {
  const weights = config.weights

  return (
    frecency.git_recency * weights.git_recency +
    frecency.git_frequency * weights.git_frequency +
    frecency.git_status_boost * weights.git_status
  )
}
```

### Git Recency Calculation

```typescript
function gitRecencyScore(lastCommitTime: number): number {
  const age = Date.now() - lastCommitTime
  const daysSince = age / (1000 * 60 * 60 * 24)

  // Exponential decay: half-life of 14 days
  return Math.exp(-daysSince / 14)
}
```

### Git Status Boost

Files appearing in `git status` (modified, staged, untracked) receive a
significant boost since they represent active work.

**Important**: Use `-z` flag for reliable parsing with spaces and renames:

```typescript
async function getGitStatusBoosts(
  projectRoot: string
): Promise<Map<string, number>> {
  // Use -z for NUL-separated output (handles spaces, renames)
  const result = await $`git -C ${projectRoot} status --porcelain -z`.quiet()
  const boosts = new Map<string, number>()

  // Split on NUL, filter empty
  const entries = result.stdout.split('\0').filter(Boolean)

  for (const entry of entries) {
    const flags = entry.slice(0, 2)
    const file = entry.slice(3)
    const fullPath = path.join(projectRoot, file)

    // Modified/staged files get full boost, untracked slightly less
    boosts.set(fullPath, flags.includes('?') ? 3.0 : 5.0)
  }

  return boosts
}
```

## SessionStart Hook

The hook runs at the beginning of each Claude Code session:

```typescript
async function onSessionStart(): Promise<void> {
  const projectRoot = process.env.CLAUDE_PROJECT_DIR
  const config = await loadConfig()

  // Verify dependencies at startup
  await checkDependencies(['fd', 'git'])

  // Use transaction to prevent partial updates
  await db.exec('BEGIN IMMEDIATE')

  try {
    // 1. Refresh index for configured roots (incremental)
    for (const root of config.index.roots) {
      await indexDirectory(root, {
        maxDepth: config.index.depth[root] ?? config.index.depth.default,
        exclude: config.index.exclude.patterns,
        incremental: true,
      })
    }

    // 2. Parse git log for frecency data (limited scope)
    if (await isGitRepo(projectRoot)) {
      await updateGitFrecency(projectRoot, {
        since: '90 days ago',
        maxCommits: 1000,
      })
      await updateGitStatusBoosts(projectRoot)
    }

    // 3. Clean up stale entries (files that no longer exist)
    await pruneDeletedFiles()

    await db.exec('COMMIT')
  } catch (err) {
    await db.exec('ROLLBACK')
    throw err
  }
}

async function checkDependencies(deps: string[]): Promise<void> {
  for (const dep of deps) {
    try {
      await $`which ${dep}`.quiet()
    } catch {
      console.warn(`[file-picker] Optional dependency '${dep}' not found`)
    }
  }
}
```

### Performance Considerations

- **Incremental updates**: Only re-index files with mtime newer than last index
- **Git log limits**: Scan last 90 days or 1000 commits, whichever is smaller
- **Shallow scans for large dirs**: Configurable `max_depth` per root
- **Exclusion patterns**: Skip `node_modules`, `.git`, `dist`, etc.
- **Async/parallel**: Index multiple roots concurrently
- **Transactions**: Prevent partial updates on crash

## Error Handling

The query client must handle failures gracefully without blocking autocomplete:

```typescript
async function suggest(input: { query: string }): Promise<string[]> {
  const timeout = 100 // ms — autocomplete must feel instant

  try {
    return await Promise.race([
      doSearch(input),
      sleep(timeout).then(() => {
        throw new Error('timeout')
      }),
    ])
  } catch (err) {
    return handleError(err, input.query)
  }
}

function handleError(err: Error, query: string): string[] {
  // Timeout — return what we have or fall back to fd
  if (err.message === 'timeout') {
    console.warn('[file-picker] Query timeout, falling back to fd')
    return fallbackToFd(query)
  }

  // Database errors — fall back to fd
  if (isDatabaseError(err)) {
    console.error('[file-picker] DB error:', err.message)
    return fallbackToFd(query)
  }

  // FTS5 syntax error (malformed query) — escape and retry
  if (isFTSSyntaxError(err)) {
    console.warn('[file-picker] FTS syntax error, escaping query')
    return searchWithEscapedQuery(query)
  }

  // Git errors — continue without git frecency
  if (isGitError(err)) {
    console.warn('[file-picker] Git unavailable, skipping frecency')
    return searchWithoutFrecency(query)
  }

  // Unknown error — return empty rather than crash
  console.error('[file-picker] Unexpected error:', err)
  return []
}

async function fallbackToFd(query: string): Promise<string[]> {
  try {
    const result = await $`fd --type f ${query} --max-results 15`.quiet()
    return result.stdout.split('\n').filter(Boolean)
  } catch {
    return [] // fd not available
  }
}

function isFTSSyntaxError(err: Error): boolean {
  return err.message.includes('fts5: syntax error')
}
```

### Error Scenarios

| Scenario                  | Behavior                                        |
| ------------------------- | ----------------------------------------------- |
| Database locked/corrupted | Fall back to `fd` search                        |
| `fd` not installed        | Return empty results                            |
| Git not available         | Skip git frecency, use index only               |
| Query timeout (>100ms)    | Return partial results or `fd` fallback         |
| Index in progress         | Query stale index (WAL allows concurrent reads) |
| FTS5 syntax error         | Escape special chars and retry                  |
| Invalid TOML config       | Use defaults, log warning                       |

## Symlink Handling

- **Symlinks are followed** during indexing
- **Deduplication**: If a symlink target is also indexed directly, prefer the
  canonical path
- **Broken symlinks**: Skip with warning, don't fail the index
- **Scope check**: Skip symlinks that resolve outside indexed roots

```typescript
async function indexFile(filePath: string, root: string): Promise<void> {
  const stat = await fs.lstat(filePath)

  if (stat.isSymbolicLink()) {
    const target = await fs.realpath(filePath).catch(() => null)

    if (!target) {
      console.warn(`[file-picker] Broken symlink: ${filePath}`)
      return
    }

    // Skip if target is outside indexed roots
    if (!isWithinIndexedRoots(target)) {
      console.warn(
        `[file-picker] Symlink escapes roots: ${filePath} -> ${target}`
      )
      return
    }

    // Index the canonical path, not the symlink
    filePath = target
  }

  // Continue with indexing...
}
```

## Configuration

### Location

```text
~/.config/claude/file-picker/config.toml
```

### Schema

```toml
# Frecency weight multipliers (all configurable)
[weights]
git_recency = 1.0          # Recent git commits
git_frequency = 0.5        # Frequently committed files
git_status = 5.0           # Currently modified files (huge boost)

# Named namespace definitions
# Use @namespace: syntax to filter
[namespaces]
claude = [".claude/**", "**/claude/**"]
docs = ["docs/**", "*.md", "README*", "CHANGELOG*"]
dev = "~/Developer"
outfitter = "~/Developer/outfitter"
config = "~/.config"

# Priority patterns affect final ranking
[priorities]
high = [
  "CLAUDE.md",
  "package.json",
  "Cargo.toml",
  "*.ts",
  "*.tsx",
  "src/**"
]
low = [
  "node_modules/**",
  "dist/**",
  "build/**",
  "*.lock",
  ".git/**",
  "*.min.js"
]

# Index configuration
[index]
# Root directories to include in global index
roots = [
  "~/Developer",
  "~/.config"
]

# Exclusion patterns (applied globally)
exclude.patterns = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "target",
  "__pycache__",
  "*.pyc"
]

# Max depth per root (prevents scanning huge directories too deeply)
[index.depth]
default = 10
"~/Developer" = 2          # Shallow for top-level project discovery
"~/.config" = 5

# Performance limits
[index.limits]
max_files_per_root = 50000
warn_threshold_mb = 500
```

## File Structure

```text
~/.config/claude/file-picker/
├── SPEC.md                    # This specification
├── config.toml                # User configuration
├── index.db                   # SQLite database (FTS5 + frecency)
├── file-suggestion.sh         # Entry point (shell wrapper)
├── src/
│   ├── index.ts               # Main query logic
│   ├── db.ts                  # Database setup and migrations
│   ├── indexer.ts             # FTS5 index management
│   ├── frecency.ts            # Frecency scoring
│   ├── git.ts                 # Git log/status parsing
│   ├── config.ts              # Config loading with defaults
│   ├── prefix.ts              # Prefix parsing
│   └── errors.ts              # Error handling utilities
├── hooks/
│   └── session-start.ts       # SessionStart hook handler
├── package.json
└── tsconfig.json
```

## Integration

### Settings Configuration

Add to `~/.config/claude/settings.json` (or project `.claude/settings.json`):

```json
{
  "fileSuggestion": {
    "type": "command",
    "command": "~/.config/claude/file-picker/file-suggestion.sh"
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup",
        "hooks": [
          {
            "type": "command",
            "command": "~/.config/claude/file-picker/hooks/session-start.sh"
          }
        ]
      }
    ]
  }
}
```

### Entry Point Script

```bash
#!/bin/bash
# file-suggestion.sh

# Read JSON from stdin, pass to Bun script
exec bun run ~/.config/claude/file-picker/src/index.ts
```

### Hook Script

```bash
#!/bin/bash
# hooks/session-start.sh

# Run index refresh in background to avoid blocking session start
bun run ~/.config/claude/file-picker/hooks/session-start.ts &
```

## Future Enhancements

### Phase 2

- **Claude session tracking** — Log files accessed during sessions for
  better frecency
- **Human vs Claude weighting** — Distinguish git commits by author (Claude
  co-author vs human)
- **File watcher daemon** — Optional background process for real-time index
  updates

### Phase 3

- **Lazy indexing** — Only index a project on first `@` invocation
- **Git-aware invalidation** — Re-index on checkout, pull, merge
- **Fuzzy matching** — Typo tolerance in queries

### Phase 4

- **Windows compatibility** — Support Windows paths and filesystems
- **Cross-machine sync** — Sync frecency data via dotfiles (relative paths
  for portability)
- **Team namespaces** — Project-level namespace definitions in
  `.claude/file-picker.toml`
- **Content search** — Optional FTS on file contents (not just paths)

## Decisions Made

**Query scoping** — Project-first, always
: More intuitive; use namespaces for global search

**Output paths** — Smart (relative in-project, absolute outside)
: Best UX for Claude context

**`@/folder:` syntax** — Single-segment only
: Simpler parsing; covers 99% of use cases

**Platform support** — macOS/Linux now
: Windows deferred to Phase 4

**Latency budget** — 100ms easily achievable
: Bun + FTS5 benchmarks at ~10ms

**Tokenization** — `unicode61` without stemmer
: Preserves path prefix matching

**Schema design** — Separate `files_meta` + FTS5 external content
: Proper PK, easier updates/deletes

## Open Questions

1. **Stale entry cleanup** — Prune files deleted >30 days ago on session
   start. Is this aggressive enough?

2. **Conflict resolution** — If the same relative path exists in multiple
   roots (via additionalDirs), show both with root prefix? Or prefer the one
   with higher frecency?

3. **Cold start behavior** — First run with empty database: fall back to `fd`
   and show "Indexing in background..." message?

4. **Schema migrations** — How to handle adding new columns in v2? SQLite
   `ALTER TABLE` or rebuild?
