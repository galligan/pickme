---
name: pickme-diagnostics
description: Troubleshoots pickme indexing issues including missing files, stale indexes, gitignore conflicts, and root coverage. Use when files are missing from pickme, index seems stale, or when debugging, troubleshooting, or investigating pickme behavior.
allowed-tools: Read, Bash(pickme *), Bash(git *), Bash(find:*), Bash(ls:*)
---

# Pickme Diagnostics Skill

Systematic troubleshooting for pickme indexing issues.

## Decision Tree

```text
File missing from pickme?
|-- Does file exist?
|   |-- No -> File path issue, not pickme
|-- Is file gitignored?
|   |-- Yes -> Check include_gitignored setting
|-- Is file in a configured root?
|   |-- No -> Add root or adjust paths
|-- Is file excluded by pattern?
|   |-- Yes -> Remove or adjust exclude pattern
|-- Is root disabled?
|   |-- Yes -> Enable root
|-- Is index stale?
|   |-- Yes -> Run pickme refresh
```

## Diagnostic Commands

### Quick Status

```bash
pickme status
pickme roots
pickme config --show
```

### Check Specific File

```bash
# Is it indexed?
pickme search --exact "path/to/file"

# Is it gitignored?
git check-ignore -v "path/to/file"

# Is it in a root?
pickme roots | grep "$(dirname path/to/file)"
```

## Common Issues and Fixes

### File Not Found in Index

Diagnosis steps:

1. Verify file exists: `ls -la path/to/file`
2. Check gitignore: `git check-ignore -v path/to/file`
3. Check roots: `pickme roots`
4. Check excludes: `pickme config --show | grep -A10 exclude`

Common fixes:

- Enable gitignored files: set `include_gitignored = true`
- Add parent as root: add a `[[roots]]` entry
- Remove overly broad exclude pattern

### Stale Index

Symptoms:

- Deleted files still appearing
- New files not showing
- Mismatch between filesystem and results

Fix:

```bash
pickme refresh
# or re-index a root
pickme index /path/to/root
```

### Too Many Results

Symptoms:

- Search returns noise
- Unrelated files appearing
- Slow search performance

Fixes:

- Add exclude patterns for generated files
- Reduce max_depth
- Use more specific roots

## Resolution Flow

1. Identify symptom (missing file, stale data, noise)
2. Run diagnostics (2-3 commands max)
3. Determine cause (use decision tree)
4. Apply fix (config edit or command)
5. Verify resolution (`pickme search` to confirm)

Target: Resolve in 2 steps after diagnosis.
