# pickme

An ultrafast `@file` suggester for Claude Code.

## Features

- **FTS5 full-text search** — SQLite-backed index for instant file lookups
- **Frecency scoring** — Files you work on frequently rank higher based on git activity
- **Prefix notation** — Scoped searches like `@config:`, `@docs:`, `#tag`
- **XDG-compliant** — Config in `~/.config/pickme/`, data in `~/.local/share/pickme/`
- **Background refresh** — Index updates happen in the background at session start

## Installation

### Prerequisites

- [Bun](https://bun.sh) runtime (`curl -fsSL https://bun.sh/install | bash`)

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

1. Detect your Claude Code install path to place `file-suggester.sh` (global recommended, project optional)
2. Back up any existing `file-suggester.sh` that exists
3. Create the suggester script and optionally register hooks in `.claude/settings.json`
4. **`@mention` files in Claude!** That's it.

> **Note:** Initial indexing takes ~50-200ms depending on codebase size. After that, searches are near-instant.

For configuration options and CLI details, see [`docs/`](docs/).

## How It Works

1. **Indexing**: `pickme index` scans directories and builds an FTS5 SQLite index
2. **Frecency**: Git commit history is analyzed to score files by activity
3. **Session hook**: When Claude Code starts, stale indexes are refreshed in the background
4. **Search**: Queries hit the FTS5 index and results are ranked by frecency

## File Locations

| File | Default Path |
|------|--------------|
| Config | `~/.config/pickme/config.toml` |
| Database | `~/.local/share/pickme/index.db` |
| Example config | [`docs/config.example.toml`](docs/config.example.toml) |

Falls back to `~/.pickme/` if XDG directories aren't available.

## Development

```bash
# Run tests
bun test

# Type check
bun run typecheck

# Run CLI in dev
bun run cli.ts search "query"
```

## License

MIT
