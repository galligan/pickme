# pickme Claude-native Integration Guide (Jan 12, 2026)

This guide describes how to expose pickme workflows as Claude Code commands and skills, reducing manual config work and providing Claude-native UX.

## Goals

- Expose pickme workflows as Claude commands and skills to reduce manual config work
- Make it easy to diagnose missing files and toggle pickme on/off in-session
- Prefer Claude-native UX: /commands + skills + hooks + auto-run bash
- **Built into binary**: Not a distributed plugin—follows existing `packages/agents/` pattern

## Architecture Overview

```
pickme/
├── packages/
│   └── agents/
│       ├── commands/
│       │   ├── config.md         # /pickme:config
│       │   ├── help.md           # /pickme:help
│       │   ├── status.md         # /pickme:status
│       │   ├── toggle.md         # /pickme:toggle
│       │   └── disable.md        # /pickme:disable
│       ├── skills/
│       │   └── pickme/           # Skills directory
│       │       ├── configuration/
│       │       │   └── SKILL.md  # Loaded by commands for config tasks
│       │       └── diagnostics/
│       │           └── SKILL.md  # Loaded by commands for troubleshooting
│       └── hooks/
│           └── hooks.json        # Optional: fire-and-forget index refresh
```

## Design Philosophy

**Commands are directive** — they express user intent and instruct Claude what to do.
**Skills are instructional** — they carry the "how" and domain knowledge.

Commands explicitly reference skills to load the relevant expertise:

```markdown
# In a command

Use the pickme-configuration skill for detailed recipes.
```

This keeps purpose tight: commands for action, skills for knowledge.

---

## Commands

Commands are user-invocable via `/command` syntax. They're markdown files with optional YAML frontmatter.

### `/pickme:config`

Edit pickme configuration with intent-driven guidance.

**File**: `packages/agents/commands/config.md`

```markdown
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

- `roots` - Index roots and namespaces
- `excludes` - Exclusion patterns
- `depth` - Max directory depth
- `gitignore` - Gitignore handling
- `disabled` - Disabled roots

## Task

Guide the user through editing their pickme configuration.

$ARGUMENTS

**If a section is specified**: Focus on that section with examples and minimal edits.
**If no section specified**: Show overview and ask what they want to configure.

For each change:

1. Explain what the change does
2. Show the minimal diff
3. Apply only after confirmation

Use the pickme-configuration skill for detailed recipes.
```

### `/pickme:help`

Diagnose why a file is missing from pickme results.

**File**: `packages/agents/commands/help.md`

```markdown
---
description: Investigate why a file is missing from pickme results
argument-hint: <file-path>
allowed-tools: Read, Bash(pickme *), Bash(git *)
---

# Pickme Diagnostics

## Target File

Path: $1

## Investigation

### 1. File Exists?

!`ls -la "$1" 2>&1`

### 2. Current Index State

!`pickme status 2>&1`

### 3. Check If Indexed

!`pickme search --exact "$1" 2>&1 || echo "Not found in index"`

### 4. Check Exclusions

!`pickme config --show | grep -A5 exclude 2>&1`

### 5. Check Gitignore

!`git check-ignore -v "$1" 2>&1 || echo "Not gitignored"`

### 6. Check Root Coverage

!`pickme roots 2>&1`

## Analysis

Based on the investigation above, determine why the file is missing:

**Common causes:**

- File is gitignored and `include_gitignored = false`
- File is in an excluded directory pattern
- File is outside all configured roots
- Max depth exceeded
- Index needs refresh

Provide specific fix suggestions. If config change needed, offer to run `/pickme:config`.
```

### `/pickme:status`

Quick health check showing index state at a glance.

**File**: `packages/agents/commands/status.md`

```markdown
---
description: Show pickme index health, root coverage, and freshness
allowed-tools: Bash(pickme *)
---

# Pickme Status

## Index Health

!`pickme status 2>&1`

## Root Coverage

!`pickme roots 2>&1`

## Index Freshness

!`pickme index --check 2>&1 || echo "Index check not available"`

## Summary

Provide a quick assessment:

- **Healthy**: Index is fresh, all roots covered
- **Stale**: Index needs refresh (suggest `pickme index --refresh`)
- **Incomplete**: Missing roots or disabled entries
- **Error**: Configuration issues (suggest `/pickme:help`)

Use the pickme-diagnostics skill if deeper investigation is needed.
```

### `/pickme:toggle`

Toggle pickme on/off for current context.

**File**: `packages/agents/commands/toggle.md`

```markdown
---
description: Toggle pickme enabled state (global or project)
argument-hint: [--global | --project]
allowed-tools: Bash(pickme *)
---

# Toggle Pickme

## Current State

!`pickme status 2>&1`

## Action

!`pickme toggle $ARGUMENTS 2>&1`

## New State

!`pickme status 2>&1`

## Summary

Report the toggle result:

- Previous state
- New state
- Scope affected (global vs project)
- Any warnings about indexed files
```

### `/pickme:disable`

Disable pickme for a specific root or globally.

**File**: `packages/agents/commands/disable.md`

```markdown
---
description: Disable pickme for specific roots or globally with status checks
argument-hint: [path | --global]
allowed-tools: Read, Edit, Bash(pickme *)
---

# Disable Pickme

## Current Configuration

!`pickme status 2>&1`
!`pickme config --show 2>&1`

## Target

$ARGUMENTS

## Pre-flight Checks

### Global Status

!`pickme status --global 2>&1`

### Active Roots

!`pickme roots 2>&1`

## Decision Tree

Based on target "$ARGUMENTS":

**If `--global`**: Disable pickme globally
**If path specified**:

- Check if path is a configured root
- If yes: Add to disabled_roots
- If no: Suggest adding to excludes instead

**If nothing specified**:

- Show current enabled roots
- Ask what to disable

## Execution

After confirmation:

1. Apply the disable action
2. Show updated configuration
3. Report what's now excluded from indexing
```

---

## Skills

Skills activate automatically based on context. They use YAML frontmatter with specific required fields.

### `pickme-configuration`

**File**: `packages/agents/skills/pickme/configuration/SKILL.md`

````markdown
---
name: pickme-configuration
description: Guides pickme configuration with recipes for common tasks like excluding directories, adding namespaces, adjusting depth, and toggling gitignore handling. Use when editing pickme config, troubleshooting indexing, or when pickme, config, exclude, roots, or namespace are mentioned.
allowed-tools: Read, Edit, Bash(pickme *)
---

# Pickme Configuration Skill

Teach Claude how to edit pickme configuration effectively with minimal diffs.

## Config File Format

Pickme uses TOML configuration:

```toml
# ~/.config/pickme/config.toml (global)
# .pickme.toml (project)

[index]
max_depth = 10
include_gitignored = false

[[roots]]
path = "~/projects"
namespace = "proj"

[[excludes]]
pattern = "node_modules"
```
````

## Common Recipes

### Exclude a Directory

```toml
# Add to excludes array
[[excludes]]
pattern = "dist"

# Or glob pattern
[[excludes]]
pattern = "*.generated.*"
```

### Add a Namespace

```toml
[[roots]]
path = "/path/to/code"
namespace = "myns"  # Results prefix with myns:
```

### Adjust Max Depth

```toml
[index]
max_depth = 5  # Default: 10
```

### Include Gitignored Files

```toml
[index]
include_gitignored = true
```

### Disable a Root Temporarily

```toml
[[roots]]
path = "~/old-project"
disabled = true  # Keeps config, stops indexing
```

## Edit Principles

1. **Minimal diffs**: Only change what's needed
2. **Preserve comments**: Keep existing documentation
3. **Validate after edit**: Run `pickme config --validate`
4. **Show before/after**: Let user confirm changes

## Validation

After any config edit:

```bash
pickme config --validate
pickme status
```

## Troubleshooting Config

| Symptom                  | Check                    | Fix              |
| ------------------------ | ------------------------ | ---------------- |
| Files missing            | `pickme roots`           | Add/enable root  |
| Too many results         | Check excludes           | Add patterns     |
| Slow indexing            | Check depth              | Reduce max_depth |
| Gitignored files missing | Check include_gitignored | Set to true      |

````

### `pickme-diagnostics`

**File**: `packages/agents/skills/pickme/diagnostics/SKILL.md`

```markdown
---
name: pickme-diagnostics
description: Troubleshoots pickme indexing issues including missing files, stale indexes, gitignore conflicts, and root coverage. Use when files are missing from pickme, index seems stale, or when debugging, troubleshooting, or investigating pickme behavior.
allowed-tools: Read, Bash(pickme *), Bash(git *), Bash(find:*), Bash(ls:*)
---

# Pickme Diagnostics Skill

Systematic troubleshooting for pickme indexing issues.

## Decision Tree

````

File missing from pickme?
├── Does file exist?
│ └── No → File path issue, not pickme
├── Is file gitignored?
│ └── Yes → Check include_gitignored setting
├── Is file in a configured root?
│ └── No → Add root or adjust paths
├── Is file excluded by pattern?
│ └── Yes → Remove/adjust exclude pattern
├── Is root disabled?
│ └── Yes → Enable root
└── Is index stale?
└── Yes → Run pickme index --refresh

````

## Diagnostic Commands

### Quick Status
```bash
pickme status
pickme roots
pickme config --show
````

### Check Specific File

```bash
# Is it indexed?
pickme search --exact "path/to/file"

# Is it gitignored?
git check-ignore -v "path/to/file"

# Is it in a root?
pickme roots | grep "$(dirname path/to/file)"
```

### Index Health

```bash
pickme status --verbose
pickme index --check
```

## Common Issues & Fixes

### File Not Found in Index

**Diagnosis steps:**

1. Verify file exists: `ls -la path/to/file`
2. Check gitignore: `git check-ignore -v path/to/file`
3. Check roots: `pickme roots`
4. Check excludes: `pickme config --show | grep -A10 exclude`

**Common fixes:**

- Enable gitignored files: Set `include_gitignored = true`
- Add parent as root: Add `[[roots]]` entry
- Remove overly broad exclude pattern

### Stale Index

**Symptoms:**

- Deleted files still appearing
- New files not showing
- Mismatch between filesystem and results

**Fix:**

```bash
pickme index --refresh
# or full rebuild
pickme index --rebuild
```

### Too Many Results

**Symptoms:**

- Search returns noise
- Unrelated files appearing
- Slow search performance

**Fixes:**

- Add exclude patterns for generated files
- Reduce max_depth
- Use more specific roots

## Resolution Flow

1. **Identify symptom** (missing file, stale data, noise)
2. **Run diagnostics** (2-3 commands max)
3. **Determine cause** (use decision tree)
4. **Apply fix** (config edit or command)
5. **Verify resolution** (`pickme search` to confirm)

Target: Resolve in ≤2 steps after diagnosis.

````

---

## Hooks (Optional)

Fire-and-forget background index refresh when files change. **Not a reminder**—silent, lightweight, non-blocking.

### Existing Pattern: SessionStart

The existing `session-start.sh` already does background refresh on session start:

```bash
# Run refresh in background
nohup "$PICKME_BIN" refresh >/dev/null 2>&1 &
exit 0
````

### PostToolUse: Auto-refresh on File Changes

Extend `hooks.json` to also refresh after file modifications:

**File**: `packages/agents/hooks/hooks.json`

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh",
            "timeout": 30
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Write(*)|Edit(*)",
        "hooks": [
          {
            "type": "command",
            "command": "${CLAUDE_PLUGIN_ROOT}/scripts/post-edit-refresh.sh",
            "timeout": 1
          }
        ]
      }
    ]
  }
}
```

**File**: `packages/agents/scripts/post-edit-refresh.sh`

```bash
#!/bin/bash
# pickme PostToolUse hook
# Refreshes index after file edits to keep @file suggestions current

PICKME_BIN="${HOME}/.local/bin/pickme"
[[ ! -x "$PICKME_BIN" ]] && PICKME_BIN="$(command -v pickme 2>/dev/null || true)"
[[ -z "$PICKME_BIN" || ! -x "$PICKME_BIN" ]] && exit 0

# Fire and forget - don't wait, don't output
nohup "$PICKME_BIN" refresh >/dev/null 2>&1 &
exit 0
```

**Key characteristics:**

- Uses same pattern as existing `session-start.sh`
- `nohup` + `&` for true background execution
- Redirects all output to `/dev/null`
- Exits immediately (exit 0)
- Silent failure if pickme not found
- 1 second timeout ensures hook itself doesn't block

**Decision**: Include this hook by default since it's silent and non-blocking. Users won't notice it's there.

---

## Implementation Checklist

### Phase 1: Commands

- [ ] Create `packages/agents/commands/` directory
- [ ] Implement `config.md` with bash execution
- [ ] Implement `help.md` with diagnostic flow
- [ ] Implement `status.md` with health summary
- [ ] Implement `toggle.md` with state reporting
- [ ] Implement `disable.md` with pre-flight checks
- [ ] Test each command with `/pickme:*` invocation

### Phase 2: Skills

- [ ] Create `packages/agents/skills/pickme/configuration/` directory
- [ ] Implement `SKILL.md` with recipes and patterns
- [ ] Create `packages/agents/skills/pickme/diagnostics/` directory
- [ ] Implement `SKILL.md` with decision tree
- [ ] Verify skills are loaded by commands (not user-invocable)

### Phase 3: Hooks

- [ ] Create `packages/agents/scripts/post-edit-refresh.sh`
- [ ] Update `hooks.json` with PostToolUse entry
- [ ] Test hook triggers on Write/Edit operations
- [ ] Verify background execution doesn't block

### Phase 4: CLI Support (if needed)

- [ ] Add `index --check` for freshness verification
- [ ] Ensure `refresh` command works silently for hooks

### Phase 5: Integration & Testing

- [ ] Commands reference skills explicitly
- [ ] `/pickme:help` chains to `/pickme:config` for fixes
- [ ] `/pickme:status` chains to `/pickme:help` for deep dives
- [ ] Test end-to-end workflows
- [ ] Verify hook doesn't add noticeable latency

---

## Testing Commands & Skills

### Debug Mode

```bash
claude --debug
# Look for:
# "Loaded skill: pickme-configuration from..."
# "Loaded skill: pickme-diagnostics from..."
```

### Command Testing

```bash
# Verify registration
/help
# Should show /pickme:config, /pickme:help, etc.

# Test each command
/pickme:config
/pickme:help path/to/missing/file
/pickme:toggle
/pickme:disable ~/some-project
```

### Skill Testing

Ask questions that should trigger skills:

- "Help me configure pickme to exclude node_modules" → pickme-configuration
- "Why isn't this file showing up in pickme results?" → pickme-diagnostics

### Verification Checklist

- [ ] Commands appear in `/help` output
- [ ] Commands execute bash sections correctly
- [ ] Skills activate on relevant queries
- [ ] Tool restrictions applied (no permission prompts for allowed tools)
- [ ] Error cases handled gracefully

---

## Notes

### Commands vs Skills

| Aspect         | Commands               | Skills                       |
| -------------- | ---------------------- | ---------------------------- |
| Invocation     | Explicit `/command`    | Loaded by commands           |
| Arguments      | `$1`, `$ARGUMENTS`     | N/A                          |
| Bash execution | `!\`command\`` syntax  | Via instructions             |
| Purpose        | Directive (what to do) | Instructional (how to do it) |
| User-facing    | Yes                    | No (background expertise)    |

### Design Decisions

1. **Namespace prefix** (`pickme:`): Groups related commands, prevents collisions
2. **Allowed-tools**: Pre-authorize common operations for speed
3. **Commands load skills**: Commands are directive, skills carry domain knowledge
4. **Command chaining**: Help → Config, Status → Help for progressive depth
5. **Fire-and-forget hooks**: Optional, silent, non-blocking index refresh
6. **Binary integration**: Built into pickme binary via `packages/agents/`, not a distributed plugin

### Command → Skill Relationship

```
/pickme:config ─────┬──→ pickme-configuration skill
                    │    (TOML recipes, edit patterns)
                    │
/pickme:help ───────┼──→ pickme-diagnostics skill
                    │    (decision tree, common fixes)
                    │
/pickme:status ─────┘
```

Commands instruct Claude to use skills for expertise. Skills are never invoked directly by users.
