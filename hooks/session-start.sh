#!/bin/bash
# hooks/session-start.sh
# Refreshes the pickme file index at session start

# Run in background to avoid blocking session startup
bun run ~/.config/pickme/hooks/session-start.ts &
