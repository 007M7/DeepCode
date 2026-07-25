/**
 * Commander adapter for the `dsh` command-line entry: the one place argv is
 * parsed and routed to a mode. `bin.ts` switches on the returned discriminant
 * and dynamic-imports that mode's module. One program: the default (no
 * subcommand) is the TUI/headless surface with option-only flags; `web` is a
 * real subcommand. Commander owns `--help`/`--version` and parse errors — it
 * prints and exits at the point of failure (a domain failure routes through
 * `command.error`), so this returns only a resolved mode.
 * @module @deepseek-ai/dsh/args
 */

import { Command, CommanderError } from 'commander'

/** The loopback host `dsh web` binds by default. */
export const LOOPBACK_HOST = '127.0.0.1'
/** The all-interfaces host `dsh web` accepts to expose the UI on the LAN. */
export const ALL_INTERFACES_HOST = '0.0.0.0'

/** Interactive TUI: the default mode. `--config` swaps the tree; `--resume <id>` rehydrates a session. */
interface TuiInvocation {
  mode: 'tui'
  config?: string
  resume?: string
}

/** Headless one-shot: `dsh -p "task"`. */
interface HeadlessInvocation {
  mode: 'headless'
  prompt: string
}

/**
 * Browser UI: `dsh web`. `host`/`port` are present only when the flag was
 * passed (validated: host is loopback/all-interfaces, port a 0–65535 integer);
 * absent means the shipped `cordis.yml` default stands, so the yml is the sole
 * source of the default. `dev` mounts the client HMR driver.
 */
interface WebInvocation {
  mode: 'web'
  host?: string
  port?: number
  dev: boolean
}

/** The resolved `dsh` invocation: exactly one mode. `--help`/`--version`/errors exit inside {@link parseDshArgs}. */
export type DshInvocation = TuiInvocation | HeadlessInvocation | WebInvocation

/** Raw web-subcommand options before validation. */
interface WebOptions {
  host?: string
  port?: string
  dev?: boolean
}

/** Validate and narrow the raw `web` options; a bad value fails loud via `command.error`. */
function resolveWeb(command: Command, options: WebOptions): WebInvocation {
  if (options.host !== undefined && options.host !== LOOPBACK_HOST && options.host !== ALL_INTERFACES_HOST) {
    command.error(`error: --host must be ${LOOPBACK_HOST} or ${ALL_INTERFACES_HOST}`)
  }
  let port: number | undefined
  if (options.port !== undefined) {
    port = Number(options.port)
    if (!/^\d+$/.test(options.port) || !Number.isInteger(port) || port > 65535) {
      command.error('error: --port must be an integer in 0-65535')
    }
  }
  return {
    mode: 'web',
    ...options.host !== undefined && { host: options.host },
    ...port !== undefined && { port },
    dev: options.dev === true,
  }
}

/**
 * Resolve the raw argv into a {@link DshInvocation}, or print and exit for
 * `--help`/`--version`/a parse error. The default (no subcommand) is the
 * TUI/headless surface; `web` is a subcommand.
 * @param argv - the arguments after the node binary and script (`process.argv.slice(2)`).
 * @param version - the version string `--version` prints; read from this app's package.json.
 * @returns the resolved invocation (only reached on a valid, non-help invocation).
 */
export function parseDshArgs(argv: readonly string[], version: string): DshInvocation {
  let resolved: DshInvocation | undefined
  const program = new Command()
    .name('dsh')
    .version(version, '-V, --version', 'output the version number')
    .description('dsh: interactive TUI (default), headless task, and browser UI')
    .exitOverride()
    // Default surface: option-only (no positional), so `web` can be a real
    // subcommand without a positional collision.
    .option('--config <path>', 'boot an alternate cordis.yml instead of the shipped tree (TUI mode)')
    .option('-p, --prompt <task>', 'run one headless turn for this task, print the result, and exit')
    .option('--resume <id>', 'resume the persisted session with this id (TUI mode)')
    .action((options: { config?: string; prompt?: string; resume?: string }) => {
      if (options.prompt !== undefined) {
        // A headless prompt owns the invocation; an empty task has nothing to
        // run, and --config/--resume are TUI inputs that must not silently
        // vanish from a headless run.
        if (options.prompt === '') program.error('error: --prompt needs a task')
        if (options.config !== undefined || options.resume !== undefined) {
          program.error('error: --prompt takes no --config or --resume')
        }
        resolved = { mode: 'headless', prompt: options.prompt }
        return
      }
      // An empty --resume= id would silently start a fresh session downstream
      // (agent-loop treats '' as no-resume), so a mistyped resume must fail loud.
      if (options.resume === '') program.error('error: --resume needs a session id')
      resolved = {
        mode: 'tui',
        ...options.config !== undefined && { config: options.config },
        ...options.resume !== undefined && { resume: options.resume },
      }
    })

  const web = program.command('web').description('serve the browser UI (host/port default to the shipped config)')
  web
    .option('--host <host>', `bind host (${LOOPBACK_HOST} or ${ALL_INTERFACES_HOST})`)
    .option('--port <port>', 'listen port (0 requests an OS-assigned port)')
    .option('--dev', 'mount the client HMR driver and watch plugin bundles for rebuilds')
    .action((options: WebOptions) => { resolved = resolveWeb(web, options) })

  try {
    program.parse(argv, { from: 'user' })
  } catch (error) {
    // Commander printed help/version/the error under `exitOverride`; exit with
    // the code it chose (0 for help/version, 1 for a parse or domain error).
    /* v8 ignore next -- Commander only throws CommanderError from parse/error under exitOverride */
    return process.exit(error instanceof CommanderError ? error.exitCode : 1)
  }
  /* v8 ignore next -- the default action or a subcommand action always resolves, or parse throws above */
  if (resolved === undefined) throw new Error('dsh: no invocation resolved')
  return resolved
}
