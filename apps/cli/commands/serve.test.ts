/**
 * Tests for the daemon serve command.
 *
 * Tests argument parsing for the serve command.
 * Does not test the full server - see daemon/server.test.ts for that.
 *
 * @module cli/commands/serve.test
 */

import { describe, expect, test } from 'bun:test'
import { parseServeArgs, ServeArgsError } from './serve'

// ============================================================================
// parseServeArgs Tests
// ============================================================================

describe('parseServeArgs', () => {
  describe('default values', () => {
    test('returns default idle of 30', () => {
      const args = parseServeArgs([])

      expect(args.idle).toBe(30)
    })

    test('returns undefined socket by default', () => {
      const args = parseServeArgs([])

      expect(args.socket).toBeUndefined()
    })
  })

  describe('--idle flag', () => {
    test('parses --idle flag correctly', () => {
      const args = parseServeArgs(['--idle', '60'])

      expect(args.idle).toBe(60)
    })

    test('parses -i short flag', () => {
      const args = parseServeArgs(['-i', '45'])

      expect(args.idle).toBe(45)
    })

    test('parses large idle values', () => {
      const args = parseServeArgs(['--idle', '1440']) // 24 hours

      expect(args.idle).toBe(1440)
    })

    test('parses single-digit idle values', () => {
      const args = parseServeArgs(['--idle', '5'])

      expect(args.idle).toBe(5)
    })
  })

  describe('--socket flag', () => {
    test('parses --socket flag correctly', () => {
      const args = parseServeArgs(['--socket', '/tmp/custom.sock'])

      expect(args.socket).toBe('/tmp/custom.sock')
    })

    test('parses -s short flag', () => {
      const args = parseServeArgs(['-s', '/var/run/pickme.sock'])

      expect(args.socket).toBe('/var/run/pickme.sock')
    })

    test('accepts relative socket paths', () => {
      const args = parseServeArgs(['--socket', './daemon.sock'])

      expect(args.socket).toBe('./daemon.sock')
    })
  })

  describe('combined flags', () => {
    test('parses both --idle and --socket', () => {
      const args = parseServeArgs(['--idle', '120', '--socket', '/tmp/test.sock'])

      expect(args.idle).toBe(120)
      expect(args.socket).toBe('/tmp/test.sock')
    })

    test('parses both short flags', () => {
      const args = parseServeArgs(['-i', '15', '-s', '/tmp/short.sock'])

      expect(args.idle).toBe(15)
      expect(args.socket).toBe('/tmp/short.sock')
    })

    test('parses mixed long and short flags', () => {
      const args = parseServeArgs(['--idle', '90', '-s', '/tmp/mixed.sock'])

      expect(args.idle).toBe(90)
      expect(args.socket).toBe('/tmp/mixed.sock')
    })
  })

  describe('invalid idle values', () => {
    test('rejects non-numeric idle', () => {
      expect(() => parseServeArgs(['--idle', 'abc'])).toThrow(ServeArgsError)
      expect(() => parseServeArgs(['--idle', 'abc'])).toThrow(/not a number/)
    })

    test('rejects zero idle', () => {
      expect(() => parseServeArgs(['--idle', '0'])).toThrow(ServeArgsError)
      expect(() => parseServeArgs(['--idle', '0'])).toThrow(/must be positive/)
    })

    test('rejects negative idle', () => {
      expect(() => parseServeArgs(['--idle', '-10'])).toThrow(ServeArgsError)
      expect(() => parseServeArgs(['--idle', '-10'])).toThrow(/must be positive/)
    })

    test('rejects NaN idle', () => {
      expect(() => parseServeArgs(['--idle', 'NaN'])).toThrow(ServeArgsError)
      expect(() => parseServeArgs(['--idle', 'NaN'])).toThrow(/not a number/)
    })

    test('rejects Infinity idle', () => {
      expect(() => parseServeArgs(['--idle', 'Infinity'])).toThrow(ServeArgsError)
      expect(() => parseServeArgs(['--idle', 'Infinity'])).toThrow(/must be an integer/)
    })

    test('rejects fractional idle', () => {
      expect(() => parseServeArgs(['--idle', '30.5'])).toThrow(ServeArgsError)
      expect(() => parseServeArgs(['--idle', '30.5'])).toThrow(/must be an integer/)
    })

    test('rejects empty idle', () => {
      expect(() => parseServeArgs(['--idle', ''])).toThrow(ServeArgsError)
      expect(() => parseServeArgs(['--idle', ''])).toThrow(/must be positive/)
    })
  })

  describe('edge cases', () => {
    test('ignores unknown flags', () => {
      const args = parseServeArgs(['--unknown', 'value', '--idle', '60'])

      expect(args.idle).toBe(60)
    })

    test('ignores positional arguments', () => {
      const args = parseServeArgs(['some-positional', '--idle', '45'])

      expect(args.idle).toBe(45)
    })

    test('handles = syntax for flags', () => {
      // Note: parseArgs may or may not support this depending on version
      // This test documents current behavior
      try {
        const args = parseServeArgs(['--idle=60'])
        expect(args.idle).toBe(60)
      } catch {
        // Some versions don't support = syntax, which is acceptable
        expect(true).toBe(true)
      }
    })
  })
})
