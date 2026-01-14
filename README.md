# pickme

An ultrafast `@file` suggester for Claude Code.

## Features

Fast file suggestion with multiple ways to search:

| Syntax             | What it does                                     |
| ------------------ | ------------------------------------------------ |
| `@query`           | Standard search (FTS + frecency)                 |
| `@namespace:query` | Scope to a namespace (e.g. `@docs:api`)          |
| `@/folder:query`   | Search within a folder name anywhere in the tree |
| `@folder/`         | List files under a folder name                   |
| `@folder/query`    | Search within a folder name (single segment)     |
| `@*.ext`           | Filter by extension (e.g. `@*.ts`)               |
| `@~term`           | Fuzzy search                                     |
| `@"My File"`       | Quote for spaces                                 |

Core benefits:

- **FTS5 full-text search** — SQLite-backed index for instant lookups
- **Frecency scoring** — Files you work on often rank higher
- **Background refresh** — Index updates on session start
- **XDG-compliant** — Config in `~/.config/pickme/`, data in `~/.local/share/pickme/`

## Installation

### Prerequisites

- [Bun](https://bun.sh) runtime (`curl -fsSL https://bun.sh/install | bash`)
- Supported platforms: macOS and Linux (arm64/x64). Windows is not supported yet.

### Install

```bash
git clone https://github.com/galligan/pickme.git
cd pickme
bun install
bun link
```

This makes `pickme` available globally.

## Quick Setup

Run the interactive installer:

```bash
pickme init
```

This will:

1. Detect your Claude Code install path to place `file-suggestion.sh`
   (global recommended, project optional)
2. Back up any existing `file-suggestion.sh` that exists
3. Create the file-suggestion script and register `fileSuggestion` in `.claude/settings.json`
4. **`@mention` files in Claude!** That's it.

> **Note:** Initial indexing takes ~50-200ms depending on codebase size.
> After that, searches are near-instant.

Full Documentation: [`docs/README.md`](docs/README.md)

## Configuration

Pickme is configured via `~/.config/pickme/config.toml` and supports
namespaces, roots, and excludes.

See [`docs/CONFIGURATION.md`](docs/CONFIGURATION.md) for full details and recipes.

## How It Works

1. **Indexing**: `pickme index` scans directories and builds an FTS5 SQLite index
2. **Frecency**: Git commit history is analyzed to score files by activity
3. **Session hook**: When Claude Code starts, stale indexes are refreshed
   in the background
4. **Search**: Queries hit the FTS5 index and results are ranked by frecency

## File Locations

| File           | Default Path                                 |
| -------------- | -------------------------------------------- |
| Config         | `~/.config/pickme/config.toml`               |
| Database       | `~/.local/share/pickme/index.db`             |
| Example config | [`config.example.toml`](config.example.toml) |

Falls back to `~/.pickme/` if XDG directories aren't available.

## Development

```bash
# Run tests
bun test

# Type check
bun run typecheck

# Build compiled binary
bun run build

# Clean build artifacts
bun run clean

# Run CLI in dev
bun run cli.ts search "query"
```

## License

MIT
