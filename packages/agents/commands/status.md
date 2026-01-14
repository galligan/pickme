---
description: Show pickme index health, root coverage, and freshness
allowed-tools: Bash(pickme *)
---

# Pickme Status

## Index Health

!`pickme status 2>&1`

## Root Coverage

!`pickme roots 2>&1`

## Summary

Provide a quick assessment:

- Healthy: active is yes, database exists, indexed roots have recent timestamps
- Stale: last indexed looks old; suggest `pickme refresh`
- Incomplete: missing roots or disabled entries
- Disabled: active is no (suggest `pickme enable`)
- Error: configuration issues (suggest /pickme:help)
