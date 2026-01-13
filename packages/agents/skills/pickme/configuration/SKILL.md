---
name: pickme-configuration
description: Guides pickme configuration with recipes for common tasks like excluding directories, adding namespaces, adjusting depth, and toggling gitignore handling. Use when editing pickme config, troubleshooting indexing, or when pickme, config, exclude, roots, or namespace are mentioned.
allowed-tools: Read, Edit, Bash(pickme *)
---

# Pickme Configuration Skill

Teach Claude how to edit pickme configuration effectively with minimal diffs.

## Config File Format

Pickme uses TOML. Use `pickme config --path` to find the active config file.

Example:

```toml
active = true

[[roots]]
path = "~/projects"
namespace = "proj"
# disabled = true

[[excludes]]
pattern = "node_modules"

[index]
max_depth = 10
include_gitignored = false

[index.depth]
"/Users/you/projects" = 5

[index.exclude]
# patterns = ["vendor"]
# gitignored_files = false
```

Notes:

- `[[excludes]]` is additive to defaults
- `index.exclude.patterns` overrides defaults and excludes when set
- `index.include_gitignored` is an alias for `index.exclude.gitignored_files`
- Use `[[roots]]` with `disabled = true` or `index.disabled = ["/path"]` to disable a root

## Common Recipes

### Exclude a Directory

```toml
[[excludes]]
pattern = "dist"
```

### Add a Namespace

```toml
[[roots]]
path = "/path/to/code"
namespace = "myns"
```

### Adjust Max Depth

```toml
[index]
max_depth = 5

[index.depth]
"/path/to/code" = 3
```

### Include Gitignored Files

```toml
[index]
include_gitignored = true
```

### Disable Pickme Globally

```toml
active = false
```

## Edit Principles

1. Minimal diffs: only change what is needed
2. Preserve comments and ordering when possible
3. Validate after edit: run `pickme config --validate`
4. Show before and after, then ask for confirmation

## Validation

After any config edit:

```bash
pickme config --validate
pickme status
```

## Troubleshooting Config

| Symptom                  | Check                    | Fix                |
| ------------------------ | ------------------------ | ------------------ |
| Files missing            | `pickme roots`           | Add or enable root |
| Too many results         | Check excludes           | Add patterns       |
| Slow indexing            | Check depth              | Reduce max_depth   |
| Gitignored files missing | Check include_gitignored | Set to true        |
