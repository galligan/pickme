/**
 * Default configuration template and helper for creating config files.
 *
 * This is shared between the CLI and init flow to ensure the config file
 * can be created consistently without duplicating the template string.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const CONFIG_TEMPLATE = `# Pickme Configuration
# ====================
# This file is optional. If it doesn't exist, pickme uses sensible defaults.
# Uncomment and edit values to customize behavior.

# active = true

[weights]
# git_recency = 1.0
# git_frequency = 0.5
# git_status = 5.0

[namespaces]
# claude = [".claude/**", "**/claude/**"]
# docs = ["docs/**", "*.md", "README*", "CHANGELOG*"]
# dev = "~/Developer"
# config = "~/.config"

[priorities]
# high = ["CLAUDE.md", "package.json", "Cargo.toml", "*.ts", "*.tsx", "src/**"]
# low = ["node_modules/**", "dist/**", "build/**", "*.lock", ".git/**", "*.min.js"]

[index]
# max_depth = 10
# include_gitignored = false
# include_hidden = false

# [[roots]]
# path = "~/Developer"
# namespace = "dev"
# disabled = false

# [[roots]]
# path = "~/.config"
# namespace = "config"
# disabled = false

# [[excludes]]
# pattern = "node_modules"

# [[excludes]]
# pattern = ".git"

[index.exclude]
# patterns = []          # override defaults and [[excludes]] when set
# gitignored_files = false

[index.include]
# patterns = []

[index.depth]
# default = 10

[index.limits]
# max_files_per_root = 50000
# warn_threshold_mb = 500
`

export function ensureConfigFile(configPath: string): boolean {
  const configDir = dirname(configPath)
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true })
  }
  if (!existsSync(configPath)) {
    writeFileSync(configPath, CONFIG_TEMPLATE)
    return true
  }
  return false
}
