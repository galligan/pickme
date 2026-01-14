/**
 * Tests for daemon status command.
 *
 * @module cli/commands/daemon-status.test
 */

import { describe, expect, test } from 'bun:test'
import { parseDaemonStatusArgs } from './daemon-status'

// ============================================================================
// Argument Parsing Tests
// ============================================================================

describe('parseDaemonStatusArgs', () => {
  test('defaults to json=false', () => {
    const args = parseDaemonStatusArgs([])
    expect(args.json).toBe(false)
  })

  test('parses --json flag', () => {
    const args = parseDaemonStatusArgs(['--json'])
    expect(args.json).toBe(true)
  })

  test('parses -j short flag', () => {
    const args = parseDaemonStatusArgs(['-j'])
    expect(args.json).toBe(true)
  })

  test('ignores unknown flags', () => {
    const args = parseDaemonStatusArgs(['--unknown', '--json'])
    expect(args.json).toBe(true)
  })

  test('ignores positional arguments', () => {
    const args = parseDaemonStatusArgs(['something', '--json'])
    expect(args.json).toBe(true)
  })
})
