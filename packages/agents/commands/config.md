---
description: Edit pickme configuration with guided examples and minimal diffs
argument-hint: [section]
allowed-tools: Read, Edit, Bash(pickme *)
---

# Pickme Configuration

## Current Config

!`pickme config --show 2>&1 || echo "No config found"`

## Config Location

!`pickme config --path 2>&1`

## Available Sections

- active (enable or disable pickme globally)
- roots (indexed roots with optional namespace and disabled flags)
- excludes (additional exclude patterns)
- namespaces (namespace to path mapping)
- depth (default and per-root max depth)
- gitignore (include_gitignored handling)
- limits (max files per root and size warnings)

## Task

Guide the user through editing their pickme configuration.

$ARGUMENTS

If a section is specified: focus on that section with examples and minimal edits.
If no section specified: show a short overview and ask what they want to configure.

For each change:

1. Explain what the change does
2. Show the minimal diff
3. Apply only after confirmation

Use the pickme-configuration skill for detailed recipes.
