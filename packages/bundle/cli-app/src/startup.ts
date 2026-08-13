/**
 * The interactive app's command-line provider: it parses the (absent) task
 * positional and `--help`, then publishes {@link CLI_STARTUP_SERVICE}. The
 * runner is an ordinary consumer whose lazy config waits for that service.
 * @module @deepseek-ai/dsh-cli-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'cli-startup'

/** Services required before the session can be started. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the interactive runner. */
export const CLI_STARTUP_SERVICE = 'cliStartup'

/** What the runner row reads from {@link CLI_STARTUP_SERVICE}. */
export interface CliStartupValues {
  /** The absolute working directory the fresh session is created in. */
  cwd: string
}

/**
 * This app's command: no positional, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function cliCommand(): Command {
  return new Command()
    .name('deepseek')
    .description('Start an interactive agent session on the local terminal.')
    .helpOption('-h, --help', 'show this help')
    .addHelpText('after', `
Examples:
  deepseek                            start the local terminal UI
  dsh cli                             equivalent profile launcher form
`)
}

/**
 * Parse and provide the interactive session's working directory as an ordinary
 * Cordis service. The command's action publishes the value; the REPL takes no
 * positional argument, so only `--help` (or a grammar rejection) leaves the
 * consumer pending.
 * @param ctx - plugin context carrying the command line.
 */
export function apply(ctx: Context): void {
  const program = cliCommand()
  program.action(() => {
    ctx.provide(CLI_STARTUP_SERVICE, { cwd: process.cwd() } satisfies CliStartupValues)
  })
  parseCmdline(ctx, program)
}
