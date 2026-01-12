#!/bin/bash
# pickme SessionStart hook
# Refreshes file indexes in the background to keep @file suggestions fast

# Check standard install location first
PICKME_BIN="${HOME}/.local/bin/pickme"

# Fallback to PATH
if [[ ! -x "$PICKME_BIN" ]]; then
  PICKME_BIN="$(command -v pickme 2>/dev/null || true)"
fi

# Exit silently if pickme not found
[[ -z "$PICKME_BIN" || ! -x "$PICKME_BIN" ]] && exit 0

# Run refresh in background
nohup "$PICKME_BIN" refresh >/dev/null 2>&1 &

exit 0
