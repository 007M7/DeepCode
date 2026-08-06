/**
 * The one-shot app's startup row: it owns the `dsh --profile headless` command
 * line — the task text is this command's positional argument — and its
 * `--help` text, then provides {@link HEADLESS_STARTUP_SERVICE} with the task
 * the user asked for. The runner waits for it, so a missing task is a usage
 * error printed by this command instead of a schema failure inside the runner.
 *
 * This app layers over the web app, and a composition has exactly one
 * command-line owner: the bundle patch disables the web startup row, and this
 * one also provides {@link WEB_STARTUP_SERVICE} so the web rows start on their
 * composed (one-shot) values.
 * @module @deepseek-ai/dsh-headless/startup
 */

import { Command } from 'commander'
import type { Context } from 'cordis'
import type { EntryOptions } from '@cordisjs/plugin-loader'
import { overrideConfig, runStartup, type RowChange } from '@deepseek-ai/dsh-cmdline'
import { WEB_STARTUP_SERVICE } from '@deepseek-ai/dsh-web-app/startup'

/** Stable Cordis plugin name. */
export const name = 'headless-startup'

/** Services required before the task can be resolved. */
export const inject = ['cmdlineArgs']

/** The startup service the one-shot runner row injects. */
export const HEADLESS_STARTUP_SERVICE = 'headlessStartup'

/** The runner row this app configures. */
const RUNNER_ROW_ID = 'headless-runner'

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
 * @param rows - the waiting rows' composed options, in tree order.
 * @returns row id → changes.
 */
function planHeadlessStartup(program: Command, rows: readonly EntryOptions[]): Map<string, RowChange> {
  const task = program.args.join(' ')
  if (task === '') program.error('error: a task is required, for example: dsh --profile headless "run the tests"')
  const runner = rows.find(row => row.id === RUNNER_ROW_ID)
  if (runner === undefined) throw new Error(`headless-startup: the composition has no waiting "${RUNNER_ROW_ID}" row to run the task`)
  return new Map([[RUNNER_ROW_ID, overrideConfig(runner, { task })]])
}

/**
 * Resolve the task and start the rows waiting for it.
 * @param ctx - plugin context carrying the command line and the Loader.
 * @returns nothing once the runner is released, or once `--help` or a missing task requested exit.
 */
export function apply(ctx: Context): Promise<void> {
  return runStartup(ctx, [HEADLESS_STARTUP_SERVICE, WEB_STARTUP_SERVICE], headlessCommand(), planHeadlessStartup)
}
