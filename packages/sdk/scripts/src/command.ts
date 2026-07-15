/**
 * Internal dsh command composition used by the package bin.
 *
 * @module @deepseek-ai/dsh-scripts/command
 */

import { parseDshArgs } from './args.ts'
import { runProjectBuild } from './build.ts'
import { runConfigCommand, type ConfigCommandContext } from './config.ts'
import { runSDK } from './runtime.ts'
import { DSH_TEMPLATES } from './templates/dsh-templates.ts'

/** Injectable process and command boundaries used by the dsh bin. */
export interface DshCommandContext extends ConfigCommandContext {
  cwd: string
  stdin: NodeJS.ReadStream
  stdout: NodeJS.WriteStream
  stderr: NodeJS.WriteStream
  run?: typeof runSDK
  build?: typeof runProjectBuild
  config?: typeof runConfigCommand
}

/** Run one parsed dsh command and return its process exit code. */
export async function runDshCommand(
  argv: readonly string[] = process.argv.slice(2),
  context: DshCommandContext = {
    cwd: process.cwd(),
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
  },
): Promise<number> {
  try {
    const args = parseDshArgs(argv)
    if (args.help || !args.command) {
      context.stdout.write(DSH_TEMPLATES.usage.render({}))
      return 0
    }
    const run = context.run ?? runSDK
    const build = context.build ?? runProjectBuild
    const config = context.config ?? runConfigCommand
    switch (args.command) {
      case 'start': await run(args.target, { cwd: context.cwd, argv: args.forwarded }); break
      case 'dev': await run(args.target, { cwd: context.cwd, dev: true, argv: args.forwarded }); break
      case 'build': await build(args.forwarded, context.cwd); break
      case 'config': {
        const result = await config(context)
        if (result.installError) return 1
        break
      }
    }
    return 0
  } catch (error) {
    context.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
    return 1
  }
}
