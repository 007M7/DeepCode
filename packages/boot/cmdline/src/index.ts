/**
 * @deepseek-ai/dsh-cmdline — the command line a dsh launcher hands to the app
 * it boots.
 *
 * The launcher parses only its own flags (`--profile`, `--patch`, the config
 * dumps) and hands everything after them to the tree verbatim through the
 * {@link CmdlineArgs} service, so an app owns its flag family, its `--help`
 * text, and its parse errors instead of the launcher knowing them.
 *
 * An app consumes those arguments from a **startup plugin**: a row that
 * injects `cmdlineArgs` and calls {@link runStartup}. What that plugin resolves
 * becomes its own service, and the rows it configures read the values from
 * there — `port: !!js ctx.get('webStartup')?.port ?? 3080` — so a flag beats
 * the value written beside it. Nothing is handed back to the launcher.
 *
 * Those rows ship `disabled: true`, because a row's config is resolved when the
 * Loader creates its fiber and a strict `ctx.get` only sees a service whose
 * providing fiber is already active. The startup plugin enables them once its
 * own fiber is active, and keeps them enabled when a recomposition of the tree
 * puts them back.
 * @module @deepseek-ai/dsh-cmdline
 */

import type { Command } from 'commander'
import type { Context } from 'cordis'
import type { Entry, EntryOptions } from '@cordisjs/plugin-loader'
// Empty type import carries the loader Context merge used to walk the tree.
import type {} from '@cordisjs/plugin-loader'

/**
 * The invocation's inner arguments: everything after the launcher's own flags,
 * verbatim and in argv order. `dsh --profile tui --resume abc` yields
 * `['--resume', 'abc']`.
 */
export interface CmdlineArgs {
  /**
   * Read the inner arguments.
   * @returns the arguments in argv order; empty when the invocation carried none.
   */
  get(): readonly string[]
}

/** Request bounded process exit; the launcher wires it to its shutdown controller. */
export interface AppExit {
  /**
   * Request exit once the tree has been disposed.
   * @param code - the process exit code.
   */
  (code: number): void
}

declare module 'cordis' {
  interface Context {
    /** The invocation's inner arguments; provided by a launcher before the tree mounts. */
    cmdlineArgs?: CmdlineArgs
    /** Bounded process-exit request; provided by a launcher before the tree mounts. */
    appExit?: AppExit
    /** Settles when the launcher has mounted the whole composition; see {@link CmdlineHost.ready}. */
    appReady?: Promise<void>
  }
}

/** The launcher facts an app needs. */
export interface CmdlineHost {
  /** The invocation's inner arguments, in argv order. */
  args: readonly string[]
  /** Bounded process-exit request. */
  exit: AppExit
  /**
   * Settles when the launcher has finished mounting, which a row that
   * publishes readiness (a URL line a supervisor waits for) must await.
   *
   * A boot mounts in phases, so Loader settlement no longer means the whole
   * composition is up: a row mounted in a later phase can observe a settled
   * tree while rows beside it have yet to mount, or while the phase that
   * mounted it is already rolling back. Rejects with the boot failure.
   */
  ready?: Promise<void>
}

/**
 * Provide the command line and the exit request on a host context before any
 * tree entry mounts. Both are launcher facts, not config: an embedding host
 * with no command line provides an empty argument list.
 * @param ctx - the host context the tree will mount under.
 * @param host - the invocation's arguments and its exit request.
 */
export function provideCmdline(ctx: Context, host: CmdlineHost): void {
  const snapshot = [...host.args]
  ctx.provide('cmdlineArgs', { get: () => snapshot })
  ctx.provide('appExit', host.exit)
  if (host.ready !== undefined) ctx.provide('appReady', host.ready)
}

/** The process streams commander output is written to; production writes to the process. */
export const internals: { stdout: { write(chunk: string): unknown }; stderr: { write(chunk: string): unknown } } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/**
 * Resolve this invocation into the values the app's rows read.
 *
 * Runs after a successful parse, with the waiting rows' composed options
 * available for a value that has to take the composition into account (the
 * `/api` fence authorities are the shipped example). Call `program.error(...)`
 * to reject the invocation with a usage message instead of throwing.
 * @param program - the parsed commander program.
 * @param rows - the waiting rows' composed options, in tree order.
 * @returns the service value the app's rows read; `undefined` keys let a row's
 * own fallback stand.
 */
export type StartupPlan<T = unknown> = (program: Command, rows: readonly EntryOptions[]) => T

/**
 * Run one app's startup: parse the invocation's inner arguments with the app's
 * own commander program, provide the resolved values as `service`, and start
 * the rows that were waiting for it.
 *
 * The rows read their values from the service, so nothing is written into
 * their config from here: a row asks for `ctx.get('<service>')?.<key>` and
 * falls back to the value written beside it, which is why a flag wins. They are
 * enabled from inside an injection on the service itself, because a strict
 * `ctx.get` only resolves a service whose providing fiber is already active,
 * and re-enabled whenever a recomposition of the tree disables them again — a
 * user editing a live patch file must not take the app down.
 *
 * Help, version, and rejected arguments are terminal for the process: the text
 * is written, the service is never provided, the app's rows stay disabled, and
 * `ctx.appExit` is requested.
 *
 * An app that layers over another one (the one-shot bundle rides over the web
 * bundle) disables the underlying startup row and names both services, because
 * a composition has exactly one command-line owner: the rows of the app it
 * absorbed then start on the values their own fallbacks name.
 * @param ctx - plugin context carrying `cmdlineArgs`, `appExit`, and the Loader.
 * @param services - the service name, or names, this startup row provides.
 * @param program - the app's commander program, with its flags and description already declared.
 * @param plan - this invocation's resolved values; omitted provides an empty value.
 * @returns the resolved values, or `undefined` when the app asked to exit
 * instead (help, version, or arguments it rejected).
 * @throws when the launcher provided no command line, or when a named service
 * is injected by no row.
 */
export function runStartup<T>(
  ctx: Context,
  services: string | readonly string[],
  program: Command,
  plan: StartupPlan<T> = (() => ({}) as T),
): T | undefined {
  const names = typeof services === 'string' ? [services] : services
  // Read through the global service store, not the property proxy: these are
  // optional host values, and a row that injects only `cmdlineArgs` may not
  // read the others as declared injections.
  const args = ctx.get('cmdlineArgs')
  const exit = ctx.get('appExit')
  if (args === undefined || exit === undefined) {
    throw new Error(`${program.name()}: the launcher must provide ctx.cmdlineArgs and ctx.appExit before the tree mounts`)
  }
  program
    .exitOverride()
    .configureOutput({
      writeOut: text => void internals.stdout.write(text),
      writeErr: text => void internals.stderr.write(text),
    })
  let values: T
  try {
    program.parse(args.get(), { from: 'user' })
    // An app can dispose the whole tree while this row is still parsing (an
    // early SIGTERM, or another app exiting). There is then nothing to resolve
    // and nothing to start, and the check below would blame the bundle for a
    // tree that simply went away.
    if (ctx.get('loader') === undefined) return undefined
    values = plan(program, waitingRows(ctx, names))
  } catch (error) {
    // exitOverride turns help, version, a parse error, and a plan's own
    // program.error() into a CommanderError; commander has already written the
    // text through the output configured above. The app's rows ship disabled,
    // so leaving them alone is what keeps the app unstarted.
    if (!isCommanderError(error)) throw error
    exit(error.exitCode)
    return undefined
  }
  for (const service of names) ctx.provide(service, values)
  return values
}

/**
 * Turn on a row this composition ships disabled, because this invocation asked
 * for it (`dsh web --dev` and its client-plugin reload chain).
 *
 * A row cannot be inserted from inside a mounting plugin — the Loader returns a
 * prefixed id it then fails to resolve — so a conditional row ships disabled
 * and an entrypoint enables it.
 * Call it from a row that mounts alongside the one being enabled: an
 * entrypoint runs before the rest of the composition, so a row it enabled
 * there would wait for services that have yet to mount.
 * @param ctx - plugin context whose Loader tree carries the row.
 * @param id - the row id.
 * @returns nothing once the row has started.
 * @throws when the composition has no row with that id.
 */
export async function enableRow(ctx: Context, id: string): Promise<void> {
  const entry = [...ctx.loader.entries()].find(candidate => candidate.options.id === id)
  if (entry === undefined) throw new Error(`dsh-cmdline: the composition has no ${JSON.stringify(id)} row to enable`)
  await entry.update({ disabled: false })
}

/**
 * The composed options of every row waiting on one of `services`, in tree order.
 * @param ctx - plugin context whose Loader tree carries the rows.
 * @param services - the startup service names.
 * @returns the waiting rows' options.
 * @throws when a service is injected by no row, which means the bundle patch
 * and its startup plugin disagree.
 */
function waitingRows(ctx: Context, services: readonly string[]): EntryOptions[] {
  for (const service of services) {
    if (waitingEntries(ctx, [service]).length === 0) {
      throw new Error(`${service}: no row injects this startup service — the bundle patch must set "inject: [${service}]" on every row this app configures`)
    }
  }
  return waitingEntries(ctx, services).map(entry => entry.options)
}

/**
 * The Loader entries waiting on any of `services`.
 * @param ctx - plugin context whose Loader tree carries the rows.
 * @param services - the startup service names.
 * @returns the waiting entries in tree order.
 */
function waitingEntries(ctx: Context, services: readonly string[]): Entry[] {
  // Called only after runStartup established the tree is still live.
  return [...ctx.loader.entries()].filter(entry => waitsForAny(entry.options.inject, services))
}

/**
 * Whether a thrown value is commander's own control-flow error (help, version,
 * a parse error, or `program.error`).
 *
 * Detected structurally, not with `instanceof`: an out-of-tree plugin brings
 * its own commander copy, whose `CommanderError` class is a different identity
 * from this package's, and an identity check there would rethrow a printed
 * help as a fatal load failure.
 * @param error - the thrown value.
 * @returns true when the value carries commander's error code and exit code.
 */
function isCommanderError(error: unknown): error is { code: string; exitCode: number } {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { code?: unknown; exitCode?: unknown }
  return typeof candidate.code === 'string' && candidate.code.startsWith('commander.')
    && typeof candidate.exitCode === 'number'
}

/**
 * Whether a row's `inject` declaration names any of `services`.
 * @param inject - the row's `inject` value: the array form, the object form, or absent.
 * @param services - the startup service names.
 * @returns true when the row waits for one of them.
 */
function waitsForAny(inject: EntryOptions['inject'], services: readonly string[]): boolean {
  if (inject === undefined || inject === null) return false
  // The array form lists service names; the object form maps each name to its
  // intercept config. Both name the service as a key of the same shape.
  const declared = Array.isArray(inject) ? inject : Object.keys(inject)
  return services.some(service => declared.includes(service))
}
