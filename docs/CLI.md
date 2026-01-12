# CLI Reference

## Commands

### `pickme init`

Interactive installer for Claude Code integration.

```bash
pickme init
```

Prompts for:
- Install location (global `~/.claude` or project `./.claude`)
- Whether to register hooks in `settings.json`

### `pickme search <query>`

Search the file index.

```bash
pickme search "component"
pickme search "@*.tsx" --limit 50
pickme search "button" --root ~/project
```

Options:
- `--limit <n>` — Maximum results (default: 20)
- `--root <path>` — Limit search to specific directory
- `--json` — Output as JSON

### `pickme index <directory>`

Index a directory.

```bash
pickme index ~/Developer
pickme index ~/.config
```

### `pickme refresh [directory]`

Refresh an existing index.

```bash
pickme refresh ~/Developer
pickme refresh  # refreshes all configured roots
```

### `pickme status`

Show index status and statistics.

```bash
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

## Configuration

See [`config.example.toml`](config.example.toml) for all available options.

Config file location: `~/.config/pickme/config.toml`

### Quick Config Example

```toml
[index]
roots = ["~/Developer", "~/.config"]

[index.exclude]
patterns = ["node_modules", ".git", "dist"]

[namespaces]
docs = ["docs/**", "*.md"]
```
