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
pickme search "/Users/me/project/src/file.ts" --exact
```

Options:

- `--limit <n>` — Maximum results (default: 20)
- `--root <path>` — Limit search to specific directory
- `--exact` — Check if a specific path is indexed
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
pickme refresh  # refreshes current directory
```

### `pickme status`

Show index status and statistics.

```bash
pickme status
pickme status --json
```

### `pickme roots`

List configured roots (and any disabled roots).

```bash
pickme roots
pickme roots --json
```

### `pickme config`

Show config path or open it in your editor.

```bash
pickme config
pickme config -o
pickme config --show
pickme config --path
pickme config --validate
```

Options:

- `-o, --open` — Open config in your editor (`$VISUAL` or `$EDITOR`)
- `--show` — Print config contents
- `--path` — Print config path
- `--validate` — Validate config and exit

### `pickme enable | disable | toggle`

Enable/disable pickme via config, or toggle the current state.

```bash
pickme enable
pickme disable
pickme toggle
```

## Environment Variables

| Variable              | Description                                         |
| --------------------- | --------------------------------------------------- |
| `PICKME_DEBUG=1`      | Enable debug logging                                |
| `PICKME_ACTIVE=false` | Bypass pickme and use Claude's built-in file picker |
| `PICKME_CONFIG_PATH`  | Override config file location                       |
| `PICKME_DB_PATH`      | Override database location                          |
| `NO_COLOR`            | Disable colored output                              |

## Configuration

See [`config.example.toml`](../config.example.toml) for all available options.

Config file location: `~/.config/pickme/config.toml`

### Quick Config Example

```toml
active = true

[index]
max_depth = 10

[[roots]]
path = "~/Developer"

[[roots]]
path = "~/.config"

[[excludes]]
pattern = "node_modules"

[[excludes]]
pattern = ".git"

[[excludes]]
pattern = "dist"

[namespaces]
docs = ["docs/**", "*.md"]
```
