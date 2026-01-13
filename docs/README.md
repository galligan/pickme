# Documentation

This folder contains expanded documentation for Pickme. Start here for usage details beyond the quick README.

## Contents

- `CLI.md` — CLI command reference
- `CONFIGURATION.md` — Configuration guide and recipes

## File Suggestions in Claude Code

Pickme integrates with Claude Code's file suggestions so you can quickly select files using `@`.

### Basic usage

- `@query` — search normally (FTS + frecency)
- `@@literal` — search for a literal `@` (escape)
- `@"My File"` — quoted literal search for names with spaces

### Namespaces

Namespaces let you scope searches to areas like docs or config.

- `@docs:query` — search inside the `docs` namespace
- `@claude:` — list files under `.claude/` (and `claude/` if present)

You can customize namespaces in your config.

### Folder helpers

- `@/folder:query` — search within a folder name anywhere in the tree
- `@folder/` — list files under that folder name
- `@folder/query` — search within that folder (single segment)
- `@.folder/` — shorthand for dot-folders

### Extension filter

- `@*.ts` — list TypeScript files
- `@*.test.ts` — list test files by extension

### Fuzzy search

Use `~` to trigger fuzzy matching.

- `@~term` — fuzzy match within the project
- `@apps:~file` — fuzzy match within a namespace
- `@apps/~file` — fuzzy match within a folder shorthand

If a normal search returns zero results, Pickme automatically falls back to fuzzy matching so you still see close hits.

### Hidden and gitignored files

Hidden and gitignored files are controlled by config:

- `index.include_hidden = true` to include dotfiles
- `index.include_gitignored = true` to include gitignored files

See `CONFIGURATION.md` for details.

### Debugging

You can log performance and results for each `@` query with:

- `PICKME_DEBUG=1` and optional `PICKME_DEBUG_SESSION=<id>`

Then use `pickme debug report` to summarize timings and results.
