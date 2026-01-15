/**
 * Init command for installing pickme hooks into Claude Code.
 *
 * Provides interactive installation of session-start hooks at global
 * and/or project levels.
 *
 * @module init
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  readFileSync,
  chmodSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import select from '@inquirer/select'
import ora from 'ora'
import { bold, cyan, dim, green, yellow } from 'yoctocolors'
import { getConfigPath } from './config'
import { ensureConfigFile } from './config-template'
import { getDataDir, getPluginDir } from './utils'
import { VERSION } from './version'

// ============================================================================
// Types
// ============================================================================

/**
 * Installation scope for the pickme hook.
 */
export type InstallScope = 'global' | 'project'

/**
 * Status of Claude configuration detection.
 */
export interface ClaudeConfigStatus {
  /** Path to Claude's config directory */
  configDir: string
  /** Path where the hook script should be installed */
  hookScriptPath: string
  /** Whether the hook script exists */
  hookScriptExists: boolean
  /** Whether pickme plugin is installed */
  pluginInstalled: boolean
}

/**
 * Result of the init command.
 */
export interface InitResult {
  success: boolean
  globalInstalled: boolean
  projectInstalled: boolean
  errors: string[]
}

export interface RunInitOptions {
  debug?: boolean
  /** Pre-selected scope (skips interactive prompt) */
  scope?: InstallScope
  /** Install plugin (skips interactive prompt) */
  plugin?: boolean
  /** Include hidden files (skips interactive prompt) */
  includeHidden?: boolean
}

// ============================================================================
// Claude Config Detection
// ============================================================================

/**
 * Gets Claude Code's config directory.
 *
 * Claude Code uses ~/.claude by default. This function checks:
 * 1. ~/.claude (Claude Code's default location)
 * 2. $XDG_CONFIG_HOME/claude (if ~/.claude doesn't exist and XDG is set)
 *
 * @returns Path to Claude's config directory
 */
export function getClaudeConfigDir(): string {
  // Claude Code uses ~/.claude by default
  const defaultPath = join(homedir(), '.claude')
  if (existsSync(defaultPath)) {
    return defaultPath
  }

  // Fallback to XDG if default doesn't exist
  if (process.env.XDG_CONFIG_HOME) {
    const xdgPath = join(process.env.XDG_CONFIG_HOME, 'claude')
    if (existsSync(xdgPath)) {
      return xdgPath
    }
  }

  // Return default even if it doesn't exist (will be created)
  return defaultPath
}

/**
 * Detects the status of Claude configuration for a given scope.
 *
 * @param scope - Whether to check global or project config
 * @param projectDir - Project directory (only used for project scope)
 * @returns Configuration status
 */
export function detectClaudeConfig(
  scope: InstallScope,
  projectDir: string = process.cwd()
): ClaudeConfigStatus {
  let configDir: string

  if (scope === 'global') {
    configDir = getClaudeConfigDir()
  } else {
    configDir = join(projectDir, '.claude')
  }

  // Hook script goes directly in the claude config dir (not in hooks subdir)
  const hookScriptPath = join(configDir, 'file-suggestion.sh')
  const hookScriptExists = existsSync(hookScriptPath)

  // Check if pickme plugin is installed
  const pluginsDir = join(configDir, 'plugins')
  const pluginInstalled = existsSync(join(pluginsDir, 'pickme'))

  return {
    configDir,
    hookScriptPath,
    hookScriptExists,
    pluginInstalled,
  }
}

// ============================================================================
// Hook Script Generation
// ============================================================================

/**
 * Generates the file-suggestion.sh script content.
 *
 * This script is called by Claude Code when the user types @ for file suggestions.
 * It runs pickme search with the query and outputs matching file paths.
 *
 * @returns Shell script content
 */
export function generateHookScript(): string {
  return `#!/bin/bash
# pickme file suggester
# Called by Claude Code when user types @ for file suggestions
# Usage: file-suggestion.sh <query>
#        file-suggestion.sh (reads JSON from stdin)

QUERY="\${1:-}"
RAW_INPUT=""

# Optional debug logging (set PICKME_DEBUG=1 when launching Claude)
PICKME_DEBUG="\${PICKME_DEBUG:-}"
PICKME_DEBUG_SESSION="\${PICKME_DEBUG_SESSION:-}"
SCRIPT_DIR="\$(cd "\$(dirname "\${BASH_SOURCE[0]}")" && pwd)"
PICKME_DATA_DIR_DEFAULT="\${XDG_DATA_HOME:-\${HOME}/.local/share}/pickme"
PICKME_DEBUG_FILE_DEFAULT="$SCRIPT_DIR/pickme-debug-roots"
PICKME_PING_FILE_DEFAULT="$SCRIPT_DIR/pickme-debug-ping.log"
PICKME_DEBUG_FILE="\${PICKME_DEBUG_FILE:-$PICKME_DEBUG_FILE_DEFAULT}"
PICKME_PING_FILE="\${PICKME_PING_FILE:-$PICKME_PING_FILE_DEFAULT}"
PICKME_CWD=""
PICKME_DATA_DIR=""
PICKME_DEBUG_LOG=""
PICKME_DEBUG_SESSION_ID=""

now_ms() {
  local ts
  ts="$(date +%s%3N 2>/dev/null || true)"
  if [[ "$ts" =~ ^[0-9]+$ ]]; then
    echo "$ts"
    return
  fi
  ts="$(date +%s)"
  echo $((ts * 1000))
}

resolve_cwd() {
  local resolved
  resolved="$(pwd -P 2>/dev/null || pwd)"
  if [[ -n "$resolved" ]]; then
    echo "$resolved"
  else
    echo "$PWD"
  fi
}

log_debug() {
  [[ -z "$PICKME_DEBUG" || -z "$PICKME_DEBUG_LOG" ]] && return 0
  local ts
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"
  echo "[$ts] $*" >> "$PICKME_DEBUG_LOG"
}

log_ping() {
  [[ -z "$PICKME_PING_FILE" ]] && return 0
  local ts
  local cwd
  ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"
  cwd="$(resolve_cwd)"
  echo "[$ts] ping ppid=$PPID cwd=$cwd" >> "$PICKME_PING_FILE"
}

parse_query_from_input() {
  local input="$1"
  local value=""
  if command -v python3 >/dev/null 2>&1; then
    value="$(PICKME_INPUT="$input" python3 - <<'PY' 2>/dev/null || true
import json, os
try:
    raw = os.environ.get("PICKME_INPUT", "")
    data = json.loads(raw) if raw else None
    if isinstance(data, dict):
        for key in ("query", "text", "input", "q"):
            val = data.get(key)
            if isinstance(val, str):
                print(val)
                break
except Exception:
    pass
PY
)"
  elif command -v python >/dev/null 2>&1; then
    value="$(PICKME_INPUT="$input" python - <<'PY' 2>/dev/null || true
import json, os
try:
    raw = os.environ.get("PICKME_INPUT", "")
    data = json.loads(raw) if raw else None
    if isinstance(data, dict):
        for key in ("query", "text", "input", "q"):
            val = data.get(key)
            if isinstance(val, str):
                print(val)
                break
except Exception:
    pass
PY
)"
  elif command -v bun >/dev/null 2>&1; then
    value="$(PICKME_INPUT="$input" bun -e '
try {
  const raw = process.env.PICKME_INPUT || "";
  const data = raw ? JSON.parse(raw) : null;
  if (data && typeof data === "object") {
    const keys = ["query","text","input","q"];
    for (const key of keys) {
      if (typeof data[key] === "string") {
        console.log(data[key]);
        break;
      }
    }
  }
} catch {}
' 2>/dev/null || true)"
  else
    value="$(printf '%s' "$input" | sed -n 's/.*"query"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' | head -n 1)"
  fi
  printf '%s' "$value"
}

debug_enabled_for_cwd() {
  local cwd
  cwd="$(resolve_cwd)"
  [[ ! -f "$PICKME_DEBUG_FILE" ]] && return 1
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="\${line%%#*}"
    line="\${line#"\${line%%[![:space:]]*}"}"
    line="\${line%"\${line##*[![:space:]]}"}"
    [[ -z "$line" ]] && continue
    root="\${line%/}"
    if [[ "$root" == "~"* ]]; then
      root="$HOME\${root#~}"
    fi
    if [[ "$root" == "/" ]]; then
      return 0
    fi
    if [[ "$cwd" == "$root" || "$cwd" == "$root/"* ]]; then
      return 0
    fi
  done < "$PICKME_DEBUG_FILE"
  return 1
}

DEBUG_MATCHED=""
if debug_enabled_for_cwd; then
  DEBUG_MATCHED=1
fi
if [[ -z "$PICKME_DEBUG" && -n "$DEBUG_MATCHED" ]]; then
  PICKME_DEBUG=1
fi
if [[ -n "$DEBUG_MATCHED" ]]; then
  log_ping
fi

# If called with JSON on stdin, extract query
if [[ -z "$QUERY" && ! -t 0 ]]; then
  RAW_INPUT="$(cat)"
  if [[ -n "$RAW_INPUT" ]]; then
    QUERY="$(parse_query_from_input "$RAW_INPUT")"
  fi
fi

if [[ -n "$PICKME_DEBUG" ]]; then
  PICKME_DATA_DIR="$PICKME_DATA_DIR_DEFAULT"
  PICKME_CWD="$(resolve_cwd)"
  if [[ -n "$PICKME_DEBUG_SESSION" ]]; then
    PICKME_DEBUG_SESSION_ID="$PICKME_DEBUG_SESSION"
  elif [[ -n "\${CLAUDE_SESSION_ID:-}" ]]; then
    PICKME_DEBUG_SESSION_ID="$CLAUDE_SESSION_ID"
  elif [[ -n "\${CLAUDE_SESSION:-}" ]]; then
    PICKME_DEBUG_SESSION_ID="$CLAUDE_SESSION"
  else
    PICKME_DEBUG_SESSION_FILE="$PICKME_DATA_DIR/pickme-debug-session-$PPID"
    if [[ -f "$PICKME_DEBUG_SESSION_FILE" ]]; then
      PICKME_DEBUG_SESSION_ID="$(cat "$PICKME_DEBUG_SESSION_FILE" 2>/dev/null || true)"
    fi
    if [[ -z "$PICKME_DEBUG_SESSION_ID" ]]; then
      if command -v openssl >/dev/null 2>&1; then
        PICKME_DEBUG_SESSION_ID="session-$(openssl rand -hex 6 2>/dev/null || true)"
      elif command -v uuidgen >/dev/null 2>&1; then
        PICKME_DEBUG_SESSION_ID="session-$(uuidgen | tr -d '-' | cut -c1-12)"
      else
        seed="$(date +%s%N 2>/dev/null || date +%s)"
        PICKME_DEBUG_SESSION_ID="session-$seed-$RANDOM$RANDOM"
      fi
      printf '%s' "$PICKME_DEBUG_SESSION_ID" > "$PICKME_DEBUG_SESSION_FILE" 2>/dev/null || true
    fi
  fi
  PICKME_DEBUG_LOG="\${PICKME_DEBUG_LOG:-$PICKME_DATA_DIR/pickme-debug-$PICKME_DEBUG_SESSION_ID.log}"
  mkdir -p "$PICKME_DATA_DIR" 2>/dev/null || true
  if [[ ! -f "$PICKME_DEBUG_LOG" ]]; then
    ts="$(date -u +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date)"
    echo "[$ts] session_start session=$PICKME_DEBUG_SESSION_ID ppid=$PPID cwd=$PICKME_CWD" >> "$PICKME_DEBUG_LOG"
  fi
fi

if [[ -n "$PICKME_DEBUG" && -n "$RAW_INPUT" ]]; then
  input_bytes="$(printf '%s' "$RAW_INPUT" | wc -c | tr -d ' ')"
  log_debug "stdin bytes=$input_bytes"
fi

# Safe values for logging
QUERY_SAFE="$QUERY"
CWD_SAFE="\${PICKME_CWD:-$PWD}"
if [[ -n "$PICKME_DEBUG" ]]; then
  QUERY_SAFE="$(printf '%q' "$QUERY")"
  CWD_SAFE="$(printf '%q' "\${PICKME_CWD:-$PWD}")"
fi

# If no query, exit silently
if [[ -z "$QUERY" ]]; then
  log_debug "skip empty-query"
  exit 0
fi

# Optional: bypass pickme and use Claude's built-in file picker
# Example: PICKME_ACTIVE=false <claude launch command>
PICKME_ACTIVE="\${PICKME_ACTIVE:-true}"
case "$PICKME_ACTIVE" in
  0|[Ff][Aa][Ll][Ss][Ee]|[Oo][Ff][Ff]|[Nn][Oo])
    if [[ -n "$PICKME_DEBUG" ]]; then
      log_debug "start mode=claude-builtin reason=env query=$QUERY_SAFE cwd=$CWD_SAFE"
      local_start_ms="$(now_ms)"
    fi
    FILE_PICKER_CLI="\${CLAUDE_FILE_PICKER_CLI:-\${HOME}/.config/claude/file-picker/cli.ts}"
    if command -v bun >/dev/null 2>&1 && [[ -f "$FILE_PICKER_CLI" ]]; then
      if [[ -n "$PICKME_DEBUG" ]]; then
        RESULTS="$(bun run "$FILE_PICKER_CLI" search "$QUERY" --quiet 2>>"$PICKME_DEBUG_LOG")"
        status=$?
        if [[ -n "$RESULTS" ]]; then
          count="$(printf '%s\\n' "$RESULTS" | wc -l | tr -d ' ')"
          printf '%s\\n' "$RESULTS"
        else
          count=0
        fi
        end_ms="$(now_ms)"
        duration_ms=$((end_ms - local_start_ms))
        log_debug "end mode=claude-builtin status=$status results=$count duration_ms=$duration_ms"
      else
        bun run "$FILE_PICKER_CLI" search "$QUERY" --quiet 2>/dev/null
      fi
    fi
    exit 0
    ;;
esac

# Config-based disable (active = false)
PICKME_CONFIG_PATH="\${PICKME_CONFIG_PATH:-\${XDG_CONFIG_HOME:-\${HOME}/.config}/pickme/config.toml}"
if [[ -f "$PICKME_CONFIG_PATH" ]]; then
  if grep -Eq '^[[:space:]]*active[[:space:]]*=[[:space:]]*false' "$PICKME_CONFIG_PATH"; then
    if [[ -n "$PICKME_DEBUG" ]]; then
      log_debug "start mode=claude-builtin reason=config query=$QUERY_SAFE cwd=$CWD_SAFE"
      local_start_ms="$(now_ms)"
    fi
    FILE_PICKER_CLI="\${CLAUDE_FILE_PICKER_CLI:-\${HOME}/.config/claude/file-picker/cli.ts}"
    if command -v bun >/dev/null 2>&1 && [[ -f "$FILE_PICKER_CLI" ]]; then
      if [[ -n "$PICKME_DEBUG" ]]; then
        RESULTS="$(bun run "$FILE_PICKER_CLI" search "$QUERY" --quiet 2>>"$PICKME_DEBUG_LOG")"
        status=$?
        if [[ -n "$RESULTS" ]]; then
          count="$(printf '%s\\n' "$RESULTS" | wc -l | tr -d ' ')"
          printf '%s\\n' "$RESULTS"
        else
          count=0
        fi
        end_ms="$(now_ms)"
        duration_ms=$((end_ms - local_start_ms))
        log_debug "end mode=claude-builtin status=$status results=$count duration_ms=$duration_ms"
      else
        bun run "$FILE_PICKER_CLI" search "$QUERY" --quiet 2>/dev/null
      fi
    fi
    exit 0
  fi
fi

# Check standard install location first
PICKME_BIN="\${HOME}/.local/bin/pickme"

# Fallback to PATH
if [[ ! -x "$PICKME_BIN" ]]; then
  PICKME_BIN="$(command -v pickme 2>/dev/null || true)"
fi

# Exit silently if pickme not found
if [[ -z "$PICKME_BIN" || ! -x "$PICKME_BIN" ]]; then
  log_debug "skip mode=pickme-missing query=$QUERY_SAFE cwd=$CWD_SAFE"
  exit 0
fi

# Run search
if [[ -n "$PICKME_DEBUG" ]]; then
  log_debug "start mode=pickme query=$QUERY_SAFE cwd=$CWD_SAFE"
  start_ms="$(now_ms)"
  RESULTS="$("$PICKME_BIN" search "$QUERY" --quiet --paths --debug 2>>"$PICKME_DEBUG_LOG")"
  status=$?
  if [[ -n "$RESULTS" ]]; then
    count="$(printf '%s\n' "$RESULTS" | wc -l | tr -d ' ')"
    printf '%s\n' "$RESULTS"
  else
    count=0
  fi
  end_ms="$(now_ms)"
  duration_ms=$((end_ms - start_ms))
  log_debug "end mode=pickme status=$status results=$count duration_ms=$duration_ms"
else
  "$PICKME_BIN" search "$QUERY" --quiet --paths 2>/dev/null
fi
exit 0
`
}

// ============================================================================
// Installation Logic
// ============================================================================

/**
 * Backs up an existing file by renaming it to .bak
 *
 * @param filePath - Path to the file to back up
 * @returns Whether backup was created
 */
function backupIfExists(filePath: string): boolean {
  if (existsSync(filePath)) {
    const backupPath = `${filePath}.bak`
    renameSync(filePath, backupPath)
    return true
  }
  return false
}

interface SettingsUpdateResult {
  updated: boolean
  created: boolean
}

function ensureFileSuggestionSetting(
  settingsPath: string,
  commandPath: string
): SettingsUpdateResult {
  let settings: Record<string, unknown> = {}
  let created = false

  if (existsSync(settingsPath)) {
    const raw = readFileSync(settingsPath, 'utf8').trim()
    if (raw) {
      try {
        settings = JSON.parse(raw) as Record<string, unknown>
      } catch {
        // Malformed JSON - backup the file and start fresh
        backupIfExists(settingsPath)
        created = true
      }
    }
  } else {
    created = true
  }

  const desired = { type: 'command', command: commandPath }
  const current = settings.fileSuggestion as { type?: string; command?: string } | undefined
  const updated = !current || current.type !== desired.type || current.command !== desired.command

  if (updated) {
    settings.fileSuggestion = desired
    writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
  }

  return { updated, created }
}

function setConfigIncludeHidden(configPath: string, includeHidden: boolean): boolean {
  ensureConfigFile(configPath)
  const content = readFileSync(configPath, 'utf8')
  const desiredValue = includeHidden ? 'true' : 'false'
  const desiredLine = `include_hidden = ${desiredValue}`

  // Regex captures: (1) leading whitespace, (2) current value, (3) trailing comment with preceding space
  if (/^(\s*)include_hidden\s*=\s*(true|false)(\s*#.*)?$/m.test(content)) {
    const updated = content.replace(
      /^(\s*)include_hidden\s*=\s*(true|false)(\s*#.*)?$/m,
      (_match, indent, _val, comment) => `${indent}include_hidden = ${desiredValue}${comment ?? ''}`
    )
    if (updated !== content) {
      writeFileSync(configPath, updated)
      return true
    }
    return false
  }

  if (/^\s*#\s*include_hidden\s*=.*$/m.test(content)) {
    const updated = content.replace(/^\s*#\s*include_hidden\s*=.*$/m, desiredLine)
    writeFileSync(configPath, updated)
    return true
  }

  if (/^\[index\]\s*$/m.test(content)) {
    const updated = content.replace(/^\[index\]\s*$/m, `[index]\n${desiredLine}`)
    writeFileSync(configPath, updated)
    return true
  }

  const updated = `${content.replace(/\s*$/, '')}\n\n[index]\n${desiredLine}\n`
  writeFileSync(configPath, updated)
  return true
}

const pluginJson = (version: string): string => `{
  "name": "pickme",
  "version": "${version}",
  "description": "Ultrafast @file suggester with background index refresh",
  "author": {
    "name": "Matt Galligan",
    "url": "https://github.com/galligan"
  }
}
`

const hooksJson = `{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "\${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
`

const sessionStartScript = `#!/bin/bash
# pickme SessionStart hook
# Refreshes file indexes in the background to keep @file suggestions fast

# Check standard install location first
PICKME_BIN="\${HOME}/.local/bin/pickme"

# Fallback to PATH
if [[ ! -x "$PICKME_BIN" ]]; then
  PICKME_BIN="$(command -v pickme 2>/dev/null || true)"
fi

# Exit silently if pickme not found
[[ -z "$PICKME_BIN" || ! -x "$PICKME_BIN" ]] && exit 0

# Run index in background
nohup "$PICKME_BIN" index >/dev/null 2>&1 &

exit 0
`

const MARKETPLACE_NAME = 'pickme-cli'

const marketplaceJson = (version: string): string => `{
  "name": "${MARKETPLACE_NAME}",
  "owner": {
    "name": "Matt Galligan",
    "email": "noreply@pickme.local"
  },
  "plugins": [
    {
      "name": "pickme",
      "source": "./plugin",
      "description": "Ultrafast @file suggester with background index refresh",
      "version": "${version}",
      "author": {
        "name": "Matt Galligan",
        "url": "https://github.com/galligan"
      }
    }
  ]
}
`

const AGENT_FILES: Record<string, string> = {
  'commands/config.md':
    '---\ndescription: Edit pickme configuration with guided examples and minimal diffs\nargument-hint: [section]\nallowed-tools: Read, Edit, Bash(pickme *)\n---\n\n# Pickme Configuration\n\n## Current Config\n!`pickme config --show 2>&1 || echo "No config found"`\n\n## Config Location\n!`pickme config --path 2>&1`\n\n## Available Sections\n- active (enable or disable pickme globally)\n- roots (indexed roots with optional namespace and disabled flags)\n- excludes (additional exclude patterns)\n- namespaces (namespace to path mapping)\n- depth (default and per-root max depth)\n- gitignore (include_gitignored handling)\n- limits (max files per root and size warnings)\n\n## Task\n\nGuide the user through editing their pickme configuration.\n\n$ARGUMENTS\n\nIf a section is specified: focus on that section with examples and minimal edits.\nIf no section specified: show a short overview and ask what they want to configure.\n\nFor each change:\n1. Explain what the change does\n2. Show the minimal diff\n3. Apply only after confirmation\n\nUse the pickme-configuration skill for detailed recipes.\n',
  'commands/help.md':
    '---\ndescription: Investigate why a file is missing from pickme results\nargument-hint: <file-path>\nallowed-tools: Read, Bash(pickme *), Bash(git *)\n---\n\n# Pickme Diagnostics\n\n## Target File\nPath: $1\n\nIf no path was provided, ask the user for the full path and retry.\n\n## Investigation\n\n### 1. File Exists?\n!`ls -la "$1" 2>&1`\n\n### 2. Current Index State\n!`pickme status 2>&1`\n\n### 3. Check If Indexed\n!`pickme search --exact "$1" 2>&1 || echo "Not found in index"`\n\n### 4. Check Exclusions\n!`pickme config --show | grep -A8 exclude 2>&1`\n\n### 5. Check Gitignore\n!`git check-ignore -v "$1" 2>&1 || echo "Not gitignored"`\n\n### 6. Check Root Coverage\n!`pickme roots 2>&1`\n\n## Analysis\n\nBased on the investigation above, determine why the file is missing.\n\nCommon causes:\n- File is gitignored and include_gitignored is false\n- File is in an excluded directory pattern\n- File is outside all configured roots\n- Max depth exceeded\n- Index needs refresh\n\nProvide specific fix suggestions. If a config change is needed, offer to run /pickme:config.\n',
  'commands/status.md':
    '---\ndescription: Show pickme index health, root coverage, and freshness\nallowed-tools: Bash(pickme *)\n---\n\n# Pickme Status\n\n## Index Health\n!`pickme status 2>&1`\n\n## Root Coverage\n!`pickme roots 2>&1`\n\n## Summary\n\nProvide a quick assessment:\n- Healthy: active is yes, database exists, indexed roots have recent timestamps\n- Stale: last indexed looks old; suggest `pickme index`\n- Incomplete: missing roots or disabled entries\n- Disabled: active is no (suggest `pickme enable`)\n- Error: configuration issues (suggest /pickme:help)\n',
  'commands/toggle.md':
    '---\ndescription: Toggle pickme enabled state (global)\nallowed-tools: Bash(pickme *)\n---\n\n# Toggle Pickme\n\n## Current State\n!`pickme status 2>&1`\n\n## Action\n!`pickme toggle 2>&1`\n\n## New State\n!`pickme status 2>&1`\n\n## Summary\n\nReport the previous state, new state, and config path if available.\n',
  'commands/disable.md':
    '---\ndescription: Disable pickme globally or disable a specific root by editing config\nargument-hint: [path | --global]\nallowed-tools: Read, Edit, Bash(pickme *)\n---\n\n# Disable Pickme\n\n## Current Configuration\n!`pickme status 2>&1`\n!`pickme config --show 2>&1`\n\n## Target\n$ARGUMENTS\n\n## Decision\n\nBased on the target:\n- If --global: disable pickme globally\n- If a path is provided: disable that root in config\n- If nothing is provided: ask what should be disabled\n\n## Execution\n\nAfter confirmation:\n1. Apply the change\n2. Show updated config\n3. Run `pickme status`\n\nNotes:\n- Global disable uses `pickme disable`\n- Root disable should update config (prefer existing [[roots]] entry with disabled = true)\n',
  'skills/pickme/configuration/SKILL.md':
    '---\nname: pickme-configuration\ndescription: Guides pickme configuration with recipes for common tasks like excluding directories, adding namespaces, adjusting depth, and toggling gitignore handling. Use when editing pickme config, troubleshooting indexing, or when pickme, config, exclude, roots, or namespace are mentioned.\nallowed-tools: Read, Edit, Bash(pickme *)\n---\n\n# Pickme Configuration Skill\n\nTeach Claude how to edit pickme configuration effectively with minimal diffs.\n\n## Config File Format\n\nPickme uses TOML. Use `pickme config --path` to find the active config file.\n\nExample:\n\n```toml\nactive = true\n\n[[roots]]\npath = "~/projects"\nnamespace = "proj"\n# disabled = true\n\n[[excludes]]\npattern = "node_modules"\n\n[index]\nmax_depth = 10\ninclude_gitignored = false\n\n[index.depth]\n"/Users/you/projects" = 5\n\n[index.exclude]\n# patterns = ["vendor"]\n# gitignored_files = false\n```\n\nNotes:\n- `[[excludes]]` is additive to defaults\n- `index.exclude.patterns` overrides defaults and excludes when set\n- `index.include_gitignored` is an alias for `index.exclude.gitignored_files`\n- Use `[[roots]]` with `disabled = true` or `index.disabled = ["/path"]` to disable a root\n\n## Common Recipes\n\n### Exclude a Directory\n\n```toml\n[[excludes]]\npattern = "dist"\n```\n\n### Add a Namespace\n\n```toml\n[[roots]]\npath = "/path/to/code"\nnamespace = "myns"\n```\n\n### Adjust Max Depth\n\n```toml\n[index]\nmax_depth = 5\n\n[index.depth]\n"/path/to/code" = 3\n```\n\n### Include Gitignored Files\n\n```toml\n[index]\ninclude_gitignored = true\n```\n\n### Disable Pickme Globally\n\n```toml\nactive = false\n```\n\n## Edit Principles\n\n1. Minimal diffs: only change what is needed\n2. Preserve comments and ordering when possible\n3. Validate after edit: run `pickme config --validate`\n4. Show before and after, then ask for confirmation\n\n## Validation\n\nAfter any config edit:\n\n```bash\npickme config --validate\npickme status\n```\n\n## Troubleshooting Config\n\n| Symptom | Check | Fix |\n| --- | --- | --- |\n| Files missing | `pickme roots` | Add or enable root |\n| Too many results | Check excludes | Add patterns |\n| Slow indexing | Check depth | Reduce max_depth |\n| Gitignored files missing | Check include_gitignored | Set to true |\n',
  'skills/pickme/diagnostics/SKILL.md':
    '---\nname: pickme-diagnostics\ndescription: Troubleshoots pickme indexing issues including missing files, stale indexes, gitignore conflicts, and root coverage. Use when files are missing from pickme, index seems stale, or when debugging, troubleshooting, or investigating pickme behavior.\nallowed-tools: Read, Bash(pickme *), Bash(git *), Bash(find:*), Bash(ls:*)\n---\n\n# Pickme Diagnostics Skill\n\nSystematic troubleshooting for pickme indexing issues.\n\n## Decision Tree\n\n```\nFile missing from pickme?\n|-- Does file exist?\n|   |-- No -> File path issue, not pickme\n|-- Is file gitignored?\n|   |-- Yes -> Check include_gitignored setting\n|-- Is file in a configured root?\n|   |-- No -> Add root or adjust paths\n|-- Is file excluded by pattern?\n|   |-- Yes -> Remove or adjust exclude pattern\n|-- Is root disabled?\n|   |-- Yes -> Enable root\n|-- Is index stale?\n|   |-- Yes -> Run pickme index\n```\n\n## Diagnostic Commands\n\n### Quick Status\n```bash\npickme status\npickme roots\npickme config --show\n```\n\n### Check Specific File\n```bash\n# Is it indexed?\npickme search --exact "path/to/file"\n\n# Is it gitignored?\ngit check-ignore -v "path/to/file"\n\n# Is it in a root?\npickme roots | grep "$(dirname path/to/file)"\n```\n\n## Common Issues and Fixes\n\n### File Not Found in Index\n\nDiagnosis steps:\n1. Verify file exists: `ls -la path/to/file`\n2. Check gitignore: `git check-ignore -v path/to/file`\n3. Check roots: `pickme roots`\n4. Check excludes: `pickme config --show | grep -A10 exclude`\n\nCommon fixes:\n- Enable gitignored files: set `include_gitignored = true`\n- Add parent as root: add a `[[roots]]` entry\n- Remove overly broad exclude pattern\n\n### Stale Index\n\nSymptoms:\n- Deleted files still appearing\n- New files not showing\n- Mismatch between filesystem and results\n\nFix:\n```bash\npickme index\n# or re-index a specific root\npickme index /path/to/root\n```\n\n### Too Many Results\n\nSymptoms:\n- Search returns noise\n- Unrelated files appearing\n- Slow search performance\n\nFixes:\n- Add exclude patterns for generated files\n- Reduce max_depth\n- Use more specific roots\n\n## Resolution Flow\n\n1. Identify symptom (missing file, stale data, noise)\n2. Run diagnostics (2-3 commands max)\n3. Determine cause (use decision tree)\n4. Apply fix (config edit or command)\n5. Verify resolution (`pickme search` to confirm)\n\nTarget: Resolve in 2 steps after diagnosis.\n',
}

function writeFileIfChanged(filePath: string, content: string, mode?: number): void {
  if (existsSync(filePath)) {
    const current = readFileSync(filePath, 'utf8')
    if (current === content) {
      if (mode !== undefined) {
        chmodSync(filePath, mode)
      }
      return
    }
  } else {
    mkdirSync(dirname(filePath), { recursive: true })
  }

  writeFileSync(filePath, content)
  if (mode !== undefined) {
    chmodSync(filePath, mode)
  }
}

function resolveAgentContent(relPath: string, fallback: string): string {
  const repoPath = join(process.cwd(), 'packages', 'agents', relPath)
  if (existsSync(repoPath)) {
    return readFileSync(repoPath, 'utf8')
  }
  return fallback
}

function cleanupLegacyAgentFiles(pluginDir: string): void {
  const legacyCommandsDir = join(pluginDir, 'commands', 'pickme')
  if (existsSync(legacyCommandsDir)) {
    try {
      rmSync(legacyCommandsDir, { recursive: true, force: true })
    } catch {
      // Best effort cleanup
    }
  }
}

function ensureAgentFiles(pluginDir: string): void {
  cleanupLegacyAgentFiles(pluginDir)
  for (const [relPath, fallback] of Object.entries(AGENT_FILES)) {
    const content = resolveAgentContent(relPath, fallback)
    const targetPath = join(pluginDir, relPath)
    writeFileIfChanged(targetPath, content)
  }
}

function ensurePluginDir(version: string): void {
  const pluginDir = getPluginDir()
  const pluginMetaDir = join(pluginDir, '.claude-plugin')
  const hooksDir = join(pluginDir, 'hooks')
  const scriptsDir = join(pluginDir, 'scripts')

  mkdirSync(pluginMetaDir, { recursive: true })
  mkdirSync(hooksDir, { recursive: true })
  mkdirSync(scriptsDir, { recursive: true })

  const pluginJsonPath = join(pluginMetaDir, 'plugin.json')
  writeFileIfChanged(pluginJsonPath, pluginJson(version))

  const hooksJsonPath = join(hooksDir, 'hooks.json')
  writeFileIfChanged(hooksJsonPath, hooksJson)

  const sessionStartPath = join(scriptsDir, 'session-start.sh')
  writeFileIfChanged(sessionStartPath, sessionStartScript, 0o755)

  ensureAgentFiles(pluginDir)
}

function ensureMarketplace(version: string): { root: string; name: string } {
  const dataDir = getDataDir()
  const marketplaceDir = join(dataDir, '.claude-plugin')
  const marketplacePath = join(marketplaceDir, 'marketplace.json')
  const desired = marketplaceJson(version)

  mkdirSync(marketplaceDir, { recursive: true })

  if (existsSync(marketplacePath)) {
    try {
      const existing = JSON.parse(readFileSync(marketplacePath, 'utf8')) as {
        name?: string
        plugins?: Array<{ name?: string; source?: string }>
      }
      const hasName = existing.name === MARKETPLACE_NAME
      const pickmePlugin = Array.isArray(existing.plugins)
        ? existing.plugins.find(plugin => plugin?.name === 'pickme')
        : undefined
      const hasPickme = Boolean(pickmePlugin)
      const hasExpectedSource = pickmePlugin?.source === './plugin'
      if (!hasName || !hasPickme || !hasExpectedSource) {
        writeFileSync(marketplacePath, desired)
      }
    } catch {
      writeFileSync(marketplacePath, desired)
    }
  } else {
    writeFileSync(marketplacePath, desired)
  }

  return { root: dataDir, name: MARKETPLACE_NAME }
}

/**
 * Options for installHook.
 */
export interface InstallHookOptions {
  /** Whether to install the pickme plugin for Claude Code. Default: true */
  installPlugin?: boolean
  /** Enable verbose debug output */
  debug?: boolean
}

/**
 * Installs the pickme hook for a given scope.
 *
 * @param scope - Whether to install globally or in project
 * @param projectDir - Project directory (for project scope)
 * @param options - Installation options
 * @returns Success status
 */
export async function installHook(
  scope: InstallScope,
  projectDir: string = process.cwd(),
  options: InstallHookOptions = {}
): Promise<{
  success: boolean
  error?: string
  backedUp?: boolean
  pluginInstalled?: boolean
  settingsUpdated?: boolean
}> {
  const { installPlugin = true, debug = false } = options
  const status = detectClaudeConfig(scope, projectDir)
  const logDebug = (message: string) => {
    if (debug) {
      console.error(dim(`[debug] ${message}`))
    }
  }

  try {
    // Create config directory if it doesn't exist
    const configDir = status.configDir
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true })
    }

    // Back up existing hook script
    const backedUp = backupIfExists(status.hookScriptPath)

    // Write the hook script
    const scriptContent = generateHookScript()
    writeFileSync(status.hookScriptPath, scriptContent, { mode: 0o755 })

    // Ensure Claude uses this script for @file suggestions
    let settingsUpdated = false
    const settingsPath = join(status.configDir, 'settings.json')
    try {
      const settingsResult = ensureFileSuggestionSetting(settingsPath, status.hookScriptPath)
      settingsUpdated = settingsResult.updated
      if (debug && settingsUpdated) {
        logDebug(`Updated fileSuggestion setting at ${settingsPath}`)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { success: false, error: `Failed to update settings.json: ${message}` }
    }

    let pluginInstalled = false

    // Optionally install the pickme plugin
    if (installPlugin) {
      ensurePluginDir(VERSION)
      const marketplace = ensureMarketplace(VERSION)
      const pluginScope = scope === 'global' ? 'user' : 'project'

      logDebug(`Adding marketplace at ${marketplace.root}`)
      const addMarketplace = Bun.spawnSync(
        ['claude', 'plugin', 'marketplace', 'add', marketplace.root],
        {
          cwd: projectDir,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      )

      if (addMarketplace.exitCode !== 0) {
        const stdout = addMarketplace.stdout.toString()
        const stderr = addMarketplace.stderr.toString()
        if (debug) {
          logDebug(`Marketplace add exit code: ${addMarketplace.exitCode}`)
          if (stdout.trim()) logDebug(`Marketplace add stdout: ${stdout.trim()}`)
          if (stderr.trim()) logDebug(`Marketplace add stderr: ${stderr.trim()}`)
        }
        const combined = `${stdout}\n${stderr}`.toLowerCase()
        const alreadyInstalled =
          combined.includes('already installed') || combined.includes('already exists')
        if (!alreadyInstalled) {
          return {
            success: false,
            error: `Failed to add marketplace: ${(stderr || stdout).trim()}`,
          }
        }
      }

      // Run: claude plugin install pickme@<marketplace> --scope user|project
      const pluginRef = `pickme@${marketplace.name}`
      logDebug(`Installing plugin ${pluginRef} (scope: ${pluginScope})`)
      const result = Bun.spawnSync(
        ['claude', 'plugin', 'install', pluginRef, '--scope', pluginScope],
        {
          cwd: projectDir,
          stdout: 'pipe',
          stderr: 'pipe',
        }
      )

      if (result.exitCode === 0) {
        pluginInstalled = true
      } else {
        const stderr = result.stderr.toString()
        const stdout = result.stdout.toString()
        if (debug) {
          logDebug(`Plugin install exit code: ${result.exitCode}`)
          if (stdout.trim()) logDebug(`Plugin install stdout: ${stdout.trim()}`)
          if (stderr.trim()) logDebug(`Plugin install stderr: ${stderr.trim()}`)
        }
        // Don't fail if plugin is already installed
        if (!stderr.includes('already installed')) {
          return {
            success: false,
            error: `Failed to install plugin: ${(stderr || stdout).trim()}`,
          }
        }
        pluginInstalled = true // Already installed is success
      }
    }

    return { success: true, backedUp, pluginInstalled, settingsUpdated }
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

// ============================================================================
// Interactive Init Flow
// ============================================================================

/**
 * Select theme with cyan pointer and custom styling.
 */
const selectTheme = {
  prefix: { idle: green('?'), done: green('✔') },
  icon: { cursor: cyan('\u276F') }, // ❯ in cyan/teal
  style: {
    message: (text: string) => text, // Override Inquirer's default bold
    disabled: (text: string) => dim(text),
    highlight: (text: string) => text, // No special highlighting, pointer indicates selection
    help: (text: string) => dim('  ' + text + ' • q quit'), // Dim hints + quit
  },
}

/**
 * Prompts user with select, supporting 'q' to quit.
 * Returns null if user cancels.
 */
async function selectWithQuit<T>(config: {
  message: string
  choices: Array<{ name: string; value: T; disabled?: boolean | string }>
}): Promise<T | null> {
  // Set up 'q' key listener
  const stdin = process.stdin
  const wasRaw = stdin.isRaw
  let cancelled = false
  let selectPromise: ReturnType<typeof select<T>> | null = null

  const onKeypress = (data: Buffer) => {
    const key = data.toString()
    if (key === 'q' || key === 'Q') {
      cancelled = true
      if (selectPromise) {
        selectPromise.cancel()
      }
    }
  }

  stdin.on('data', onKeypress)

  try {
    selectPromise = select<T>({
      ...config,
      theme: selectTheme,
    })
    const result = await selectPromise
    return result
  } catch (err) {
    // User cancelled (Ctrl+C or 'q')
    if (
      cancelled ||
      (err instanceof Error &&
        (err.message.includes('User force closed') || err.name === 'ExitPromptError'))
    ) {
      return null
    }
    throw err
  } finally {
    stdin.removeListener('data', onKeypress)
    // Restore raw mode if it was changed
    if (stdin.isRaw !== wasRaw && stdin.isTTY) {
      stdin.setRawMode(wasRaw)
    }
  }
}

/**
 * Builds the choice name with proper styling.
 *
 * Format: "Globally (~/.claude)" or "Globally (~/.claude) (installed)"
 * - Path is dim
 * - Entire line is dim if installed
 */
function buildChoiceName(label: string, path: string, isInstalled: boolean): string {
  const fullPath = `${path}/file-suggestion.sh`
  const pathPart = dim(fullPath)
  const baseName = `${label} ${pathPart}`

  if (isInstalled) {
    return dim(`${label} ${fullPath} (installed)`)
  }
  return baseName
}

/**
 * Runs the interactive init command.
 *
 * @param projectDir - Current project directory
 * @returns Init result
 */
export async function runInit(
  projectDir: string = process.cwd(),
  options: RunInitOptions = {}
): Promise<InitResult> {
  const {
    debug = false,
    scope: preSelectedScope,
    plugin: preSelectedPlugin,
    includeHidden: preSelectedHidden,
  } = options
  const isNonInteractive = preSelectedScope !== undefined
  const result: InitResult = {
    success: true,
    globalInstalled: false,
    projectInstalled: false,
    errors: [],
  }

  // Header (skip in non-interactive mode for cleaner output)
  if (!isNonInteractive) {
    console.log()
    console.log(bold('Install Pickme'))
    console.log(dim('An ultrafast @file suggester for Claude'))
  }

  // Silent detection phase
  const globalStatus = detectClaudeConfig('global', projectDir)
  const projectStatus = detectClaudeConfig('project', projectDir)

  // Determine installation status
  // "Fully installed" = script exists AND plugin installed
  const globalFullyInstalled = globalStatus.pluginInstalled && globalStatus.hookScriptExists
  const projectFullyInstalled = projectStatus.pluginInstalled && projectStatus.hookScriptExists

  // "Partially installed" = script exists but plugin NOT installed (needs override confirmation)
  const globalScriptOnly = globalStatus.hookScriptExists && !globalStatus.pluginInstalled
  const projectScriptOnly = projectStatus.hookScriptExists && !projectStatus.pluginInstalled

  // Show warning if existing script found (not fully installed)
  const hasExistingScript =
    (globalStatus.hookScriptExists && !globalFullyInstalled) ||
    (projectStatus.hookScriptExists && !projectFullyInstalled)

  if (!isNonInteractive && hasExistingScript) {
    console.log()
    console.log(yellow('Existing .claude/file-suggestion.sh will be backed up automatically.'))
  }

  if (!isNonInteractive) {
    console.log()
  }

  // Check if all options are fully installed
  if (globalFullyInstalled && projectFullyInstalled) {
    console.log('Pickme is already installed in all locations.\n')
    return result
  }

  let selectedScope: InstallScope

  // Non-interactive mode: use pre-selected scope
  if (isNonInteractive) {
    selectedScope = preSelectedScope
    // Check if already installed at requested scope
    const alreadyInstalled =
      selectedScope === 'global' ? globalFullyInstalled : projectFullyInstalled
    if (alreadyInstalled) {
      console.log(
        `Pickme is already installed ${selectedScope === 'global' ? 'globally' : 'for this project'}.\n`
      )
      return result
    }
  } else {
    // Interactive mode: prompt for scope selection
    // Build choices with styled names
    type Choice = {
      name: string
      value: InstallScope
      disabled: boolean | string
    }

    const choices: Choice[] = [
      {
        name: buildChoiceName('Globally (best)', '~/.claude', globalFullyInstalled),
        value: 'global',
        disabled: globalFullyInstalled,
      },
      {
        name: buildChoiceName('Project', './.claude', projectFullyInstalled),
        value: 'project',
        disabled: projectFullyInstalled,
      },
    ]

    // Check if all options are disabled
    const allDisabled = choices.every(c => c.disabled !== false)
    if (allDisabled) {
      console.log('Pickme is already installed in all locations.\n')
      return result
    }

    // Prompt for scope selection
    const scopeChoice = await selectWithQuit<InstallScope>({
      message: 'Install location:',
      choices,
    })

    if (scopeChoice === null) {
      console.log('\nInstallation cancelled.\n')
      result.success = false
      return result
    }

    selectedScope = scopeChoice
    console.log()
  }

  // Check if we need override confirmation (only in interactive mode)
  const needsOverride =
    (selectedScope === 'global' && globalScriptOnly) ||
    (selectedScope === 'project' && projectScriptOnly)

  // Override confirmation only in interactive mode
  if (!isNonInteractive && needsOverride) {
    const status = selectedScope === 'global' ? globalStatus : projectStatus
    const displayPath = status.hookScriptPath.replace(homedir(), '~')

    const confirmed = await selectWithQuit<boolean>({
      message: `Ok to override ${displayPath}?\n  ${dim('Current file will be saved as file-suggestion.sh.bak')}`,
      choices: [
        {
          name: 'Yes',
          value: true,
          disabled: false,
        },
        {
          name: 'No, cancel installation',
          value: false,
          disabled: false,
        },
      ],
    })

    if (confirmed === null || confirmed === false) {
      console.log('\nInstallation cancelled.\n')
      result.success = false
      return result
    }

    console.log()
  }

  let installPluginChoice: boolean
  let includeHiddenChoice: boolean

  if (isNonInteractive) {
    // Non-interactive: use defaults or pre-selected values
    installPluginChoice = preSelectedPlugin ?? true
    includeHiddenChoice = preSelectedHidden ?? false
  } else {
    // Interactive: prompt for plugin installation
    const pluginAnswer = await selectWithQuit<boolean>({
      message: `Install Claude Code plugin for full capability?\n  ${dim('Adds SessionStart hook for background index refresh')}`,
      choices: [
        {
          name: `Yes ${dim('(recommended)')}`,
          value: true,
          disabled: false,
        },
        {
          name: `No ${dim('(index manually with pickme index)')}`,
          value: false,
          disabled: false,
        },
      ],
    })

    if (pluginAnswer === null) {
      console.log('\nInstallation cancelled.\n')
      result.success = false
      return result
    }

    installPluginChoice = pluginAnswer
    console.log()

    // Interactive: prompt for hidden files
    const hiddenAnswer = await selectWithQuit<boolean>({
      message: `Include hidden files/folders in search?\n  ${dim('Enables @.claude/ and other dot-directories')}`,
      choices: [
        {
          name: `Yes ${dim('(index dotfiles)')}`,
          value: true,
          disabled: false,
        },
        {
          name: `No ${dim('(default)')}`,
          value: false,
          disabled: false,
        },
      ],
    })

    if (hiddenAnswer === null) {
      console.log('\nInstallation cancelled.\n')
      result.success = false
      return result
    }

    includeHiddenChoice = hiddenAnswer
    console.log()
  }

  // Install in selected scope with spinner
  const scopeLabel = selectedScope === 'global' ? 'Global' : 'Project'
  const installSpinner = ora(`Installing ${scopeLabel.toLowerCase()}...`).start()

  const installResult = await installHook(selectedScope, projectDir, {
    installPlugin: installPluginChoice,
    debug,
  })

  let configCreated = false
  let includeHiddenUpdated = false
  if (installResult.success) {
    try {
      const configPath = process.env.PICKME_CONFIG_PATH ?? getConfigPath()
      configCreated = ensureConfigFile(configPath)
      includeHiddenUpdated = setConfigIncludeHidden(configPath, includeHiddenChoice)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(yellow(`Warning: Failed to create config file: ${message}`))
    }

    let msg = `${scopeLabel} installed`
    if (installResult.backedUp) {
      msg += ' (previous backed up)'
    }
    if (installResult.pluginInstalled) {
      msg += ' + plugin installed'
    }
    if (installResult.settingsUpdated) {
      msg += ' + settings updated'
    }
    if (configCreated) {
      msg += ' + config created'
    }
    if (includeHiddenUpdated) {
      msg += includeHiddenChoice ? ' + hidden files enabled' : ' + hidden files disabled'
    }
    installSpinner.succeed(msg)
    if (selectedScope === 'global') {
      result.globalInstalled = true
    } else {
      result.projectInstalled = true
    }
  } else {
    installSpinner.fail(`Failed to install ${scopeLabel.toLowerCase()}: ${installResult.error}`)
    result.errors.push(installResult.error ?? 'Unknown error')
    result.success = false
  }

  console.log()

  return result
}
