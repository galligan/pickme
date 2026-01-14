import { runInit } from '../../init'
import { EXIT_ERROR, EXIT_SUCCESS, type OutputOptions } from '../core'

export async function cmdInit(opts: OutputOptions): Promise<number> {
  const result = await runInit(process.cwd(), { debug: opts.debug })
  return result.success ? EXIT_SUCCESS : EXIT_ERROR
}
