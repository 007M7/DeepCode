/**
 * @deepseek-ai/dsh-cmdline — the command line a dsh launcher hands to the app
 * it boots.
 *
 * The launcher parses only its own flags (`--profile`, `--patch`, the config
 * dumps) and hands everything after them to the tree verbatim through the
 * {@link CmdlineArgs} service, so an app owns its flag family, its `--help`
 * text, and its parse errors instead of the launcher knowing them.
 *
 * Any app plugin can inject `cmdlineArgs` and call {@link parseCmdline}. A
 * provider may publish the parsed values as its own service, and ordinary rows
 * can inject that service and read it from lazily resolved config —
 * `port: !!js ctx.webStartup.port ?? 3080` — so a flag beats the value written
 * beside it. No row has launcher-level command-line status.
 * @module @deepseek-ai/dsh-cmdline
 */

import type { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'

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

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The invocation's inner arguments; provided by a launcher before the tree mounts. */
    cmdlineArgs?: CmdlineArgs
    /** Bounded process-exit request; provided by a launcher before the tree mounts. */
    appExit?: AppExit
  }
}

/** The launcher facts an app needs. */
export interface CmdlineHost {
  /** The invocation's inner arguments, in argv order. */
  args: readonly string[]
  /** Bounded process-exit request. */
  exit: AppExit
}

/**
 * Provide the command line and the exit request on a host context before any
 * tree entry mounts. Both are launcher facts, not config: an embedding host
 * with no command line provides an empty argument list.
 * @param ctx - the host context the tree will mount under.
 * @param host - the invocation's arguments and its exit request.
 */
export function provideCmdline(ctx: Context, host: CmdlineHost): void {
  const snapshot: readonly string[] = Object.freeze([...host.args])
  ctx.provide('cmdlineArgs', { get: () => snapshot })
  ctx.provide('appExit', host.exit)
}

/** The process streams commander output is written to; production writes to the process. */
export const internals: { stdout: { write(chunk: string): unknown }; stderr: { write(chunk: string): unknown } } = {
  stdout: process.stdout,
  stderr: process.stderr,
}

/**
 * Resolve parsed arguments into an app-owned value. Call
 * `program.error(...)` to reject the invocation with a usage message instead
 * of throwing.
 * @param program - the parsed commander program.
 * @param ctx - the plugin context that received the command line.
 * @returns the value an ordinary provider plugin may publish.
 */
export type CmdlinePlan<T = unknown> = (program: Command, ctx: Context) => T

/**
 * Parse the launcher's immutable argument snapshot with an app's commander
 * program. The caller decides whether and how to publish the returned value;
 * this helper has no Loader-row or service ownership semantics.
 *
 * Help, version, and rejected arguments are terminal for the process: commander
 * writes the text, the helper requests `ctx.appExit`, and it returns
 * `undefined` so the caller publishes nothing.
 * @param ctx - plugin context carrying `cmdlineArgs` and `appExit`.
 * @param program - the app's commander program, with its flags and description already declared.
 * @param plan - this invocation's resolved value; omitted returns an empty object.
 * @returns the resolved value, or `undefined` when the app asked to exit.
 * @throws when the launcher did not provide the command line and exit request.
 */
export function parseCmdline<T>(
  ctx: Context,
  program: Command,
  plan: CmdlinePlan<T> = (() => ({}) as T),
): T | undefined {
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value and the plugin only needs to inject cmdlineArgs.
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
  try {
    program.parse(args.get(), { from: 'user' })
    return plan(program, ctx)
  } catch (error) {
    // exitOverride turns help, version, a parse error, and a plan's own
    // program.error() into a CommanderError; commander has already written the
    // text through the output configured above.
    if (!isCommanderError(error)) throw error
    exit(error.exitCode)
    return undefined
  }
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
