# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

pickme is an ultrafast `@file` suggester for Claude Code. It provides fast file
search with FTS5 (SQLite full-text search) indexing and frecency-based ranking
derived from git history.

## Development Commands

```bash
# Run all tests
bun test

# Run a single test file
bun test packages/core/src/db.test.ts

# Type check
bun run typecheck

# Format code (runs on pre-commit)
bun run format

# Lint markdown (runs on pre-commit)
bun run lint:md

# Full lint (typecheck + markdown)
bun run lint

# Build compiled binary
bun run build

# Run CLI in development
bun run cli <command>
```

## Architecture

### Module Structure

```text
apps/
└── cli/                 # CLI application
    ├── index.ts         # Entry point (shebang)
    ├── main.ts          # Command router
    ├── commands/        # Individual command implementations
    ├── core.ts          # Exit codes, flag parsing, output helpers
    └── helpers.ts       # CLI utilities

packages/
├── agents/              # Claude Code plugin
│   └── ...
└── core/                # Core library
    └── src/
        ├── index.ts     # Public API (createFilePicker factory)
        ├── db.ts        # SQLite database operations with FTS5
        ├── indexer.ts   # Directory scanning and file indexing
        ├── frecency.ts  # Git-based frecency scoring
        ├── config.ts    # TOML config loading and validation
        ├── prefix.ts    # Query prefix parsing (@namespace:, @*.ext, etc.)
        ├── types.ts     # Shared type definitions
        └── daemon/      # Background daemon for persistent search
            ├── server.ts    # Unix socket server (Bun.serve)
            ├── client.ts    # Unix socket client with circuit breaker
            ├── protocol.ts  # NDJSON request/response protocol
            ├── handlers.ts  # Request handlers (search, health, status)
            └── cache.ts     # LRU cache for search results

hooks/
└── session-start.ts     # Claude Code session hook for index refresh
```

### Data Flow

1. **Indexing**: `indexDirectory()` scans filesystem, stores in `files_meta`
2. **FTS5**: Triggers sync `files_fts` virtual table for full-text search
3. **Frecency**: Git history via `buildFrecencyRecords()`, stored in `frecency`
4. **Search**: `parseQuery()` parses query, FTS5 search combined with frecency
5. **Daemon**: Optional persistent process serves searches via Unix socket

### Key Design Decisions

- **FTS5 External Content**: `files_fts` uses `content=files_meta` for space efficiency
- **XDG Compliance**: Config in `~/.config/pickme/`, data in `~/.local/share/pickme/`
- **Frecency Scoring**: Combines git recency (exponential decay), frequency
  (commit count), and status boost (modified/staged files)
- **Query Prefixes**: Supports `@namespace:query`, `@*.ext`, `@/folder:query`, `@~fuzzy`
- **Daemon Mode**: Circuit breaker pattern with fallback to direct CLI

### Database Schema

```sql
files_meta      -- Source of truth: path, filename, dir_components, root, mtime
files_fts       -- FTS5 virtual table (external content from files_meta)
frecency        -- Git-based scores: git_recency, git_frequency, git_status_boost
watched_roots   -- Indexed directories: root, max_depth, last_indexed, file_count
```

## Testing Patterns

- Tests use `bun:test` with describe/it/expect
- Database tests create temp directories via `mkdtempSync`
- Mock git repos created with `initGitRepo()` helper
- Cleanup with `afterAll()` to remove temp files

## Configuration

Config file: `~/.config/pickme/config.toml`

Key sections:

- `index.roots` - Directories to index
- `index.exclude.patterns` - Glob patterns to skip
- `namespaces` - Named search scopes (e.g., `@docs:query`)
- `weights` - Frecency score multipliers
- `daemon` - Background service settings

## Git Hooks (Lefthook)

- **pre-commit**: format, lint:md
- **pre-push**: lint, clean
