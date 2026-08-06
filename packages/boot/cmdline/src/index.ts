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
 * injects `cmdlineArgs` and calls {@link runStartup}. Every row the app
 * configures from flags declares `inject: [<startup service>]` in the bundle
 * patch and therefore waits until the startup plugin provides that service;
 * `--help` prints, disables exactly those rows, and requests exit, so the app
 * never starts.
 * @module @deepseek-ai/dsh-cmdline
 */

import type { Command } from 'commander'
import type { Context } from 'cordis'
import type { PatchOptions } from '@cordisjs/plugin-include'
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

/**
 * The launcher's own patch layer, above every layer a user can edit.
 *
 * A startup row's decisions are facts about this invocation, so they must
 * outlive a recomposition of the tree: a launcher that re-applies its patch
 * stack when the user edits a live patch file rebuilds every row from its
 * composed options, which would otherwise silently reset a flag-configured
 * row (a browser served on `--port 8080` would move back to the composed
 * port on an unrelated edit).
 */
export interface AppPatches {
  /**
   * Record patches the launcher must keep applying on every later composition.
   * @param patches - the startup row's decisions, as patches over the composed rows.
   */
  contribute(patches: readonly PatchOptions[]): void
}

declare module 'cordis' {
  interface Context {
    /** The invocation's inner arguments; provided by a launcher before the tree mounts. */
    cmdlineArgs?: CmdlineArgs
    /** Bounded process-exit request; provided by a launcher before the tree mounts. */
    appExit?: AppExit
    /** The launcher's own patch layer; provided by a launcher that recomposes its tree. */
    appPatches?: AppPatches
  }
}

/** The launcher facts an app's startup row needs. */
export interface CmdlineHost {
  /** The invocation's inner arguments, in argv order. */
  args: readonly string[]
  /** Bounded process-exit request. */
  exit: AppExit
  /**
   * Sink for startup decisions a later recomposition must keep. A launcher
   * that never recomposes its tree (a one-shot embedding host) omits it.
   */
  contribute?: AppPatches['contribute']
}

/**
 * Provide the command line, the exit request, and the patch sink on a host
 * context before any tree entry mounts. These are launcher facts, not config:
 * an embedding host with no command line provides an empty argument list.
 * @param ctx - the host context the tree will mount under.
 * @param host - the invocation's arguments, exit request, and optional patch sink.
 */
export function provideCmdline(ctx: Context, host: CmdlineHost): void {
  const snapshot = [...host.args]
  ctx.provide('cmdlineArgs', { get: () => snapshot })
  ctx.provide('appExit', host.exit)
  const contribute = host.contribute
  if (contribute !== undefined) ctx.provide('appPatches', { contribute })
}

/** The process streams commander output is written to; production writes to the process. */
export const internals: { stdout: { write(chunk: string): unknown }; stderr: { write(chunk: string): unknown } } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/**
 * What a startup plugin changes on one waiting row. A row with a change is
 * re-enabled as part of applying it; `{ disabled: true }` keeps it off (and
 * `{ disabled: false }` is how a row a bundle ships disabled gets turned on).
 */
export type RowChange = Omit<Partial<EntryOptions>, 'id' | 'inject'>

/**
 * Decide this invocation's changes for the rows waiting on an app's startup
 * service.
 *
 * Runs after a successful parse, with every waiting row's composed options
 * (bundle layers, the user's layers, and any `--patch` overlay already
 * applied), so a decision can read what the composition agreed on before
 * overriding it. Call `program.error(...)` to reject the invocation with a
 * usage message instead of throwing.
 * @param program - the parsed commander program.
 * @param rows - the waiting rows' composed options, in tree order.
 * @returns row id → the changes for that row; ids absent from the map start unchanged.
 */
export type StartupPlan = (program: Command, rows: readonly EntryOptions[]) => Map<string, RowChange>

/**
 * Run one app's startup: parse the invocation's inner arguments with the app's
 * own commander program, apply the resulting changes to the waiting rows, and
 * release them by providing the startup service they inject.
 *
 * A waiting row's config is resolved when the Loader creates its fiber, which
 * happens while the row is still waiting, so writing a new config onto that
 * fiber would never reach the plugin. Each changed row is therefore recycled —
 * disabled, then re-enabled with its new values — which drops the stale fiber
 * and resolves the config again. Recycling deliberately leaves `inject` alone:
 * an `inject` update restarts the row from its unwrapped callback and loses the
 * plugin's own static injections.
 *
 * Help, version, and rejected arguments are terminal for the process: the text
 * is written, every waiting row is disabled so the settlement audit sees a tree
 * that was asked not to start this app, and `ctx.appExit` is requested.
 *
 * An app that layers over another one (the one-shot bundle rides over the web
 * bundle) disables the underlying startup row and names both startup services,
 * because a composition has exactly one command-line owner: the rows of the app
 * it absorbed then start on their composed values.
 * @param ctx - plugin context carrying `cmdlineArgs`, `appExit`, and the Loader.
 * @param services - the startup service name, or names, that this app's rows declare in their `inject`.
 * @param program - the app's commander program, with its flags and description already declared.
 * @param plan - this invocation's per-row changes; omitted starts the waiting rows unchanged.
 * @returns nothing once the waiting rows are released, or once the exit was requested.
 * @throws when the launcher provided no command line, when a startup service is
 * declared by no row, or when `plan` names a row that is not waiting.
 */
export async function runStartup(
  ctx: Context,
  services: string | readonly string[],
  program: Command,
  plan: StartupPlan = () => new Map(),
): Promise<void> {
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
  let decisions: Map<string, RowChange>
  let rows: EntryOptions[]
  try {
    program.parse(args.get(), { from: 'user' })
    // An app can dispose the whole tree while this row is still parsing (an
    // early SIGTERM, or another app exiting). There is then nothing to
    // configure and nothing to release, and the checks below would blame the
    // bundle for a tree that simply went away.
    if (ctx.get('loader') === undefined) return
    rows = waitingRows(ctx, names)
    decisions = plan(program, rows)
  } catch (error) {
    // exitOverride turns help, version, a parse error, and a plan's own
    // program.error() into a CommanderError; commander has already written the
    // text through the output configured above.
    if (!isCommanderError(error)) throw error
    for (const entry of waitingEntries(ctx, names)) await stopRow(entry)
    exit(error.exitCode)
    return
  }
  const unknown = [...decisions.keys()].filter(id => !rows.some(row => row.id === id))
  if (unknown.length > 0) {
    throw new Error(`${program.name()}: startup planned changes for row(s) ${unknown.join(', ')}, which inject none of ${names.join(', ')}`)
  }
  const contributed: PatchOptions[] = []
  for (const entry of waitingEntries(ctx, names)) {
    const change = decisions.get(entry.options.id)
    if (change === undefined) continue
    await stopRow(entry)
    await entry.update({ disabled: false, ...change })
    contributed.push({ id: entry.options.id, disabled: false, ...change })
  }
  // Hand the same decisions to the launcher as patches, so a later
  // recomposition of the tree (a user editing a live patch file) rebuilds
  // these rows with this invocation's values instead of the composed ones.
  if (contributed.length > 0) ctx.get('appPatches')?.contribute(contributed)
  // The rows are ready; providing the service they inject starts them, and a
  // row this invocation left disabled stays that way.
  for (const service of names) ctx.provide(service, true)
}

/**
 * Stop a waiting row, including one whose own mount is still in flight.
 *
 * Disabling alone is not a barrier: a row whose init has not finished has no
 * fiber yet, so the update returns while that init goes on to create one, and
 * the re-enable would then take the config-patch path, which a still-waiting
 * fiber never applies — the row would start on stale values. Letting the mount
 * settle first gives the disable a fiber to dispose. A row the composition
 * ships disabled has no mount to settle and is left alone.
 * @param entry - the waiting row's Loader entry.
 */
async function stopRow(entry: Entry): Promise<void> {
  await entry.refresh()
  await entry.update({ disabled: true })
}

/**
 * Merge flag overrides over a waiting row's composed config.
 *
 * A row's composed config is what the bundle patches and the user's own layers
 * agreed on; a flag replaces exactly the keys it names and leaves the rest of
 * that agreement intact.
 * @param options - the waiting row's composed options.
 * @param overrides - the values this invocation's flags decided, by config key.
 * @returns the change to put in a {@link StartupPlan}'s map.
 */
export function overrideConfig(options: EntryOptions, overrides: Record<string, unknown>): RowChange {
  return { config: { ...(options.config ?? {}) as Record<string, unknown>, ...overrides } }
}

/**
 * The composed options of every row waiting on one of `services`, in tree order.
 * @param ctx - plugin context whose Loader tree carries the rows.
 * @param services - the startup service names.
 * @returns the waiting rows' options.
 * @throws when a startup service is declared by no row, which means the bundle
 * patch and its startup plugin disagree.
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
  return [...ctx.loader.entries()].filter(entry => services.some(service => waitsFor(entry.options.inject, service)))
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
 * Whether a row's `inject` declaration names `service`.
 * @param inject - the row's `inject` value: the array form, the object form, or absent.
 * @param service - the startup service name.
 * @returns true when the row waits for it.
 */
function waitsFor(inject: EntryOptions['inject'], service: string): boolean {
  if (inject === undefined || inject === null) return false
  // The array form lists service names; the object form maps each name to its
  // intercept config. Both name the service as a key of the same shape.
  return Array.isArray(inject) ? inject.includes(service) : Object.hasOwn(inject, service)
}
