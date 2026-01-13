# Configuration

Pickme reads configuration from:

- `~/.config/pickme/config.toml`
- or `PICKME_CONFIG_PATH` when set

A full example lives at the repo root: `config.example.toml`.

## Key settings

### Global

- `active` — enable or disable Pickme globally

### Index settings

```toml
[index]
# include_hidden = false
# include_gitignored = false
```

- `include_hidden` — include dotfiles and dot folders
- `include_gitignored` — include files ignored by git

### Roots

```toml
[[roots]]
path = "~/Developer"
namespace = "dev"
# disabled = false
```

- `path` — root directory to index
- `namespace` — optional name used by `@namespace:`
- `disabled` — set true to exclude that root entirely

### Excludes

```toml
[[excludes]]
pattern = "node_modules"
```

Use `[[excludes]]` to add to the default exclusion list. To replace defaults entirely, use `[index.exclude]`:

```toml
[index.exclude]
patterns = ["node_modules", ".git", "dist"]
# gitignored_files = false
```

### Namespaces

```toml
[namespaces]
docs = ["docs/**", "*.md", "README*"]
config = "~/.config"
```

Namespaces can be either:

- A path (string)
- A list of glob patterns

### Depth

```toml
[index.depth]
default = 10
"~/Developer" = 8
```

Use this to keep indexing fast in large repos.

### Limits

```toml
[index.limits]
max_files_per_root = 50000
warn_threshold_mb = 500
```

## Recipes

### Include hidden + gitignored files

```toml
[index]
include_hidden = true
include_gitignored = true
```

### Disable Pickme globally

```toml
active = false
```

### Disable a single root

```toml
[[roots]]
path = "~/Developer/legacy-app"
namespace = "legacy"
disabled = true
```
