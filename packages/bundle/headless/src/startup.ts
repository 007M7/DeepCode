/**
 * The one-shot app's startup row: it owns the `dsh --profile headless` command
 * line — the task text is this command's positional argument — and its
 * `--help` text, then provides {@link HEADLESS_STARTUP_SERVICE} with the task
 * the user asked for. The runner waits for it, so a missing task is a usage
 * error printed by this command instead of a schema failure inside the runner.
 * @module @deepseek-ai/dsh-headless/startup
 */

import { Command } from 'commander'
import type { Context } from 'cordis'
import type { EntryOptions } from '@cordisjs/plugin-loader'
import { runStartup } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'headless-startup'

/** Services required before the task can be resolved. */
export const inject = ['cmdlineArgs']

/** The service this row provides and the one-shot runner row reads. */
export const HEADLESS_STARTUP_SERVICE = 'headlessStartup'

/** The row that runs the task, and the only reason this app has a command line. */
const RUNNER_ROW_ID = 'headless-runner'

/** What the runner row reads from {@link HEADLESS_STARTUP_SERVICE}. */
export interface HeadlessStartupValues {
  /** The task text this invocation asked for. */
  task: string
}

/**
 * This app's command: the task positional, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function headlessCommand(): Command {
  return new Command()
    .name('dsh --profile headless')
    .description('Answer one task, print the final assistant message, and exit.')
    .helpOption('-h, --help', 'show this help')
    .argument('[task...]', 'the task text; multiple words are joined by spaces')
    .addHelpText('after', `
Examples:
  dsh --profile headless "run the tests"     answer one task and exit
`)
}

/**
 * Turn the parsed command line into the runner row's task.
 * @param program - the parsed headless command.
 * @param rows - the rows waiting on this app's service, in tree order.
 * @returns the runner row's service value.
 * @throws when the composition has no runner row, which would otherwise accept
 * a task and silently run nothing.
 */
function planHeadlessStartup(program: Command, rows: readonly EntryOptions[]): HeadlessStartupValues {
  const task = program.args.join(' ')
  if (task === '') program.error('error: a task is required, for example: dsh --profile headless "run the tests"')
  if (!rows.some(row => row.id === RUNNER_ROW_ID)) {
    throw new Error(`headless-startup: the composition has no waiting "${RUNNER_ROW_ID}" row to run the task`)
  }
  return { task }
}

/**
 * Resolve the task for the runner waiting on `headlessStartup`.
 * @param ctx - plugin context carrying the command line and the Loader.
 * @returns nothing once the runner is started, or once `--help` or a missing task requested exit.
 */
export function apply(ctx: Context): void {
  runStartup(ctx, HEADLESS_STARTUP_SERVICE, headlessCommand(), planHeadlessStartup)
}
