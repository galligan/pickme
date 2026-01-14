import { VERSION } from '../version'
import { NAME } from './constants'

export function showHelp(): void {
  console.log(`${NAME} v${VERSION} - Fast file search for Claude Code

USAGE
  ${NAME} <command> [options]

COMMANDS
  search <query>     Search for files matching query
  query <pattern>    Search files (minimal output for hooks)
  index <path>       Index a directory
  refresh <path>     Refresh an existing index
  status             Show index status and configuration
  roots              List configured roots
  config             Show config path or open in editor
  enable             Enable pickme via config
  disable            Disable pickme via config
  toggle             Toggle pickme enabled state
  debug              Manage file-suggestion debug logging
  bench              Launch Claude with a debug session or report on sessions
  init               Install pickme hooks into Claude Code
  update             Update pickme to the latest version
  serve              Start the pickme daemon for fast file search
  daemon status      Show daemon status

UPDATE OPTIONS
  -c, --check        Check for updates without installing

DAEMON OPTIONS
  -i, --idle <mins>  Shutdown after N minutes idle (default: 30)
  -s, --socket <path>  Custom socket path

SEARCH OPTIONS
  -r, --root <path>  Project root for relative paths (default: cwd)
  -n, --limit <n>    Maximum results (default: 20)
  --exact            Check if a specific path is indexed

QUERY OPTIONS
  -C, --cwd <path>   Working directory (default: cwd)
  -l, --limit <n>    Maximum results (default: 50)
  --no-daemon        Skip daemon, use CLI directly

CONFIG OPTIONS
  -o, --open         Open config in your editor
  --path             Print the config path
  --show             Print the config contents
  --validate         Validate config and exit

GLOBAL OPTIONS
  --json             Output as JSON
  -q, --quiet        Suppress non-essential output
  --no-color         Disable colored output
  --debug            Enable verbose debug output
  -h, --help         Show this help
  -v, --version      Show version

EXAMPLES
  ${NAME} search "button"
  ${NAME} search "@*.ts" --root ~/project --limit 50
  ${NAME} search "@~settings"
  ${NAME} query "*.tsx" --cwd ~/project
  ${NAME} query "config" --no-daemon
  ${NAME} index ~/Developer
  ${NAME} refresh .
  ${NAME} refresh --force .
  ${NAME} status --json
  ${NAME} roots
  ${NAME} config --show
  ${NAME} config -o
  ${NAME} toggle
  ${NAME} debug status
  ${NAME} debug report
  ${NAME} debug report --latest
  ${NAME} debug enable
  ${NAME} bench
  ${NAME} bench report
  ${NAME} bench report --all
  ${NAME} bench --session bench-001
  ${NAME} update --check
  ${NAME} update
  ${NAME} serve
  ${NAME} serve --idle 60
  ${NAME} serve -s /tmp/custom.sock
  ${NAME} daemon status
  ${NAME} daemon status --json

ENVIRONMENT
  PICKME_DEBUG=1     Enable debug logging
  PICKME_DEBUG_LOG   Override debug log file path for file-suggestion.sh
  PICKME_DEBUG_SESSION  Session id used in debug log filename
  PICKME_DEBUG_FILE  Override debug toggle file path
  NO_COLOR           Disable colored output
`)
}
