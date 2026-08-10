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
 * there — `port: !!js ctx.webStartup.port ?? 3080` — so a flag beats
 * the value written beside it. Nothing is handed back to the launcher.
 *
 * Loader delays each row's config interpolation until its declared injections
 * are active. A startup row consumes `cmdlineArgs`, provides the app's resolved
 * values, and thereby activates only the rows that depend on those values.
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
   * Loader mounts sibling rows concurrently, so one row can become active
   * while another is still mounting or while the whole boot is rolling back.
   * Rejects with the boot failure.
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

/**
 * Detect whether an active row consumes the launcher's command line.
 *
 * The Loader-row injection is the declaration: an active row that names
 * `cmdlineArgs` owns startup for this composition. No bundle manifest field or
 * plugin import is needed, so an out-of-tree app adds its command line by
 * adding the same injection its startup plugin already requires.
 * @param rows - the composed Loader rows.
 * @returns whether this composition has a command-line owner.
 * @throws when more than one active row claims the command line.
 */
export function hasCmdlineConsumer(rows: readonly EntryOptions[]): boolean {
  const consumers: string[] = []
  const visit = (entries: readonly EntryOptions[], ancestorDisabled = false, prefix = ''): void => {
    for (const row of entries) {
      const id = prefix + row.id
      // Loader group containers stay active when disabled, but their children
      // inherit that disabled state.
      const active = row.group === true || (!ancestorDisabled && row.disabled !== true)
      if (active && waitsForAny(row.inject, ['cmdlineArgs'])) consumers.push(id)
      if (row.group === true && Array.isArray(row.config)) {
        visit(row.config, ancestorDisabled || row.disabled === true, `${id}:`)
      }
    }
  }
  visit(rows)
  if (consumers.length > 1) {
    const ids = consumers.map(id => JSON.stringify(id)).join(', ')
    throw new Error(`dsh-cmdline: multiple active rows inject cmdlineArgs (${ids}); disable all but one startup row`)
  }
  return consumers.length === 1
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
 * @param ctx - the startup row's context, for resolving composed fallbacks before the service exists.
 * @returns the service value the app's rows read; `undefined` keys let a row's
 * own fallback stand.
 */
export type StartupPlan<T = unknown> = (program: Command, rows: readonly EntryOptions[], ctx: Context) => T

/**
 * Run one app's startup: parse the invocation's inner arguments with the app's
 * own commander program and provide the resolved values as `service`. The
 * Loader then activates the rows that were waiting for the provided service.
 *
 * The rows read their values from the service, so nothing is written into
 * their config from here: a row asks for `ctx.<service>.<key>` and
 * falls back to the value written beside it, which is why a flag wins. Loader
 * resolves a row's config only after its injections are active. A live
 * recomposition reads the service that remains active, so editing a user patch
 * cannot reset an invocation value.
 *
 * Help, version, and rejected arguments are terminal for the process: the text
 * is written, the service is never provided, dependent rows stay pending, and
 * `ctx.appExit` is requested.
 *
 * A custom app that layers over another one disables the underlying startup
 * row and names every startup service its retained rows inject, because a
 * composition has exactly one command-line owner.
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
    values = plan(program, waitingRows(ctx, names), ctx)
  } catch (error) {
    // exitOverride turns help, version, a parse error, and a plan's own
    // program.error() into a CommanderError; commander has already written the
    // text through the output configured above. With no startup service,
    // dependent rows remain pending and the app stays unstarted.
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
 * and a row mounted beside it enables it after startup resolves the invocation.
 * The Loader keeps that activation in memory, separate from serialized options,
 * so reapplying the composition cannot restore the invocation's row to disabled.
 * @param ctx - plugin context whose Loader tree carries the row.
 * @param id - the row id.
 * @returns nothing once the row has started or is waiting for its dependencies.
 * @throws when the Loader or named row is absent.
 */
export async function enableRow(ctx: Context, id: string): Promise<void> {
  const loader = ctx.get('loader')
  if (loader === undefined) throw new Error('dsh-cmdline: enabling a row requires the Loader service')
  const entry = [...loader.entries()].find(candidate => candidate.options.id === id)
  if (entry === undefined) throw new Error(`dsh-cmdline: the composition has no ${JSON.stringify(id)} row to enable`)
  await entry.enableRuntime()
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
