---
description: Disable pickme globally or disable a specific root by editing config
argument-hint: [path | --global]
allowed-tools: Read, Edit, Bash(pickme *)
---

# Disable Pickme

## Current Configuration

!`pickme status 2>&1`
!`pickme config --show 2>&1`

## Target

$ARGUMENTS

## Decision

Based on the target:

- If --global: disable pickme globally
- If a path is provided: disable that root in config
- If nothing is provided: ask what should be disabled

## Execution

After confirmation:

1. Apply the change
2. Show updated config
3. Run `pickme status`

Notes:

- Global disable uses `pickme disable`
- Root disable should update config (prefer existing [[roots]] entry
  with disabled = true)
