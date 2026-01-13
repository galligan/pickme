import { NAME } from './constants'

export const EXIT_SUCCESS = 0
export const EXIT_ERROR = 1
export const EXIT_USAGE = 2

export interface OutputOptions {
  json: boolean
  quiet: boolean
  noColor: boolean
  debug: boolean
}

const isTTY = process.stdout.isTTY ?? false
const supportsColor = isTTY && !process.env.NO_COLOR

export function parseGlobalFlags(args: string[]): { flags: OutputOptions; rest: string[] } {
  const flags: OutputOptions = {
    json: false,
    quiet: false,
    noColor: !supportsColor,
    debug: false,
  }
  const rest: string[] = []

  for (const arg of args) {
    switch (arg) {
      case '--json':
        flags.json = true
        break
      case '--quiet':
      case '-q':
        flags.quiet = true
        break
      case '--no-color':
        flags.noColor = true
        break
      case '--debug':
        flags.debug = true
        break
      default:
        rest.push(arg)
    }
  }

  return { flags, rest }
}

export function output(data: unknown, opts: OutputOptions): void {
  if (opts.quiet) return

  if (opts.json) {
    console.log(JSON.stringify(data, null, 2))
  } else if (typeof data === 'string') {
    console.log(data)
  } else {
    console.log(data)
  }
}

export function error(message: string, opts: OutputOptions): void {
  if (opts.json) {
    console.error(JSON.stringify({ error: message }))
  } else {
    console.error(`${NAME}: ${message}`)
  }
}

export function info(message: string, opts: OutputOptions): void {
  if (opts.quiet) return
  if (opts.json) return
  console.error(message)
}
