---
description: Investigate why a file is missing from pickme results
argument-hint: <file-path>
allowed-tools: Read, Bash(pickme *), Bash(git *)
---

# Pickme Diagnostics

## Target File

Path: $1

If no path was provided, ask the user for the full path and retry.

## Investigation

### 1. File Exists?

!`ls -la "$1" 2>&1`

### 2. Current Index State

!`pickme status 2>&1`

### 3. Check If Indexed

!`pickme search --exact "$1" 2>&1 || echo "Not found in index"`

### 4. Check Exclusions

!`pickme config --show | grep -A8 exclude 2>&1`

### 5. Check Gitignore

!`git check-ignore -v "$1" 2>&1 || echo "Not gitignored"`

### 6. Check Root Coverage

!`pickme roots 2>&1`

## Analysis

Based on the investigation above, determine why the file is missing.

Common causes:

- File is gitignored and include_gitignored is false
- File is in an excluded directory pattern
- File is outside all configured roots
- Max depth exceeded
- Index needs refresh

Provide specific fix suggestions. If a config change is needed, offer to run /pickme:config.
