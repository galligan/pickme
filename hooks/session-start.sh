#!/bin/bash
# hooks/session-start.sh
# Refreshes the pickme file index at session start

# Get the directory where this script lives
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Run in background to avoid blocking session startup
bun run "$SCRIPT_DIR/session-start.ts" &
