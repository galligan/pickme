# pickme

Fast file search with frecency-based ranking for Claude Code.

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

## Configuration

Create a config file at `~/.config/pickme/config.toml`:

```toml
# Directories to index
[[roots]]
path = "~/Developer"
max_depth = 10

[[roots]]
path = "~/.config"
max_depth = 5

# Frecency scoring weights
[frecency]
commit_weight = 2.0      # Weight for commit frequency
recency_weight = 1.5     # Weight for recent access
decay_days = 30          # Half-life for recency decay

# Priority patterns (boost these files in results)
[priorities]
patterns = [
  "README.md",
  "package.json",
  "tsconfig.json",
  "*.config.*"
]
boost = 1.5

# Exclusions (in addition to .gitignore)
[exclude]
patterns = [
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  "*.lock"
]
```

## Claude Code Integration

### Quick Setup

Run the interactive installer:

```bash
pickme init
```

This will:
1. Detect your Claude Code configuration (global and project-level)
2. Show which hooks are already installed
3. Let you choose where to install (global, project, or both)
4. Create the hook script and update `settings.json`

### Build the initial index

```bash
pickme index ~/Developer
pickme index ~/.config
```

### Verify it works

```bash
pickme status
pickme search "readme"
```

### Manual Setup (Alternative)

If you prefer manual configuration, add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "/path/to/pickme/hooks/session-start.sh"
          }
        ]
      }
    ]
  }
}
```

## CLI Usage

```bash
# Install hooks into Claude Code
pickme init

# Search for files
pickme search "component"
pickme search "@*.tsx" --limit 50
pickme search "button" --root ~/project

# Index a directory
pickme index ~/Developer

# Refresh an existing index
pickme refresh ~/Developer

# Show status
pickme status
pickme status --json
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PICKME_DEBUG=1` | Enable debug logging |
| `PICKME_CONFIG_PATH` | Override config file location |
| `PICKME_DB_PATH` | Override database location |
| `NO_COLOR` | Disable colored output |

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
| Hooks | `~/.config/pickme/hooks/` |

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
