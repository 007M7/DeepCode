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
 * passed — pass-through overrides with no CLI default and no CLI validation:
 * the `dsh-host-webserver` schema (`host` a loopback/all-interfaces literal,
 * `port` a natural ≤ 65535) is the single source of both the default (the
 * shipped `cordis.yml` value stands when a flag is absent) and validity (a bad
 * value fails loud at boot). `port` is `Number`-coerced only because the schema
 * wants a number, not a string. `dev` mounts the client HMR driver;
 * `workspaceRoot` is the parent directory for name-created workspaces.
 */
interface WebInvocation {
  mode: 'web'
  host?: string
  port?: number
  dev: boolean
  workspaceRoot?: string
}

/** The resolved `dsh` invocation: exactly one mode. `--help`/`--version`/errors exit inside {@link parseDshArgs}. */
export type DshInvocation = TuiInvocation | HeadlessInvocation | WebInvocation

/** Raw web-subcommand options straight from Commander. */
interface WebOptions {
  host?: string
  port?: string
  dev?: boolean
  workspaceRoot?: string
}

/**
 * Narrow the raw `web` options into a {@link WebInvocation}. No host/port
 * validation: both flow to the webserver schema, which is the sole gate. `port`
 * is coerced to a number (the schema rejects a string) but not range-checked
 * here — `NaN`/out-of-range fail loud at the schema on boot.
 */
function resolveWeb(options: WebOptions): WebInvocation {
  return {
    mode: 'web',
    ...options.host !== undefined && { host: options.host },
    ...options.port !== undefined && { port: Number(options.port) },
    dev: options.dev === true,
    ...options.workspaceRoot !== undefined && { workspaceRoot: options.workspaceRoot },
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
    .option('--host <host>', 'override the config bind host (127.0.0.1 or 0.0.0.0)')
    .option('--port <port>', 'override the config listen port (0 requests an OS-assigned port)')
    .option('--dev', 'mount the client HMR driver and watch plugin bundles for rebuilds')
    .option('--workspace-root <path>', 'parent directory for name-created workspaces')
    .action((options: WebOptions) => {
      // Commander parses the parent (default-surface) options on either side of
      // the subcommand into `program.opts()`. `web` shares none of them, so a
      // leaked `--config`/`-p`/`--resume` is a mistyped invocation that must
      // fail loud rather than silently start the web server and drop it.
      const parent = program.opts<{ config?: string; prompt?: string; resume?: string }>()
      if (parent.config !== undefined || parent.prompt !== undefined || parent.resume !== undefined) {
        program.error('error: web takes none of --config, -p/--prompt, or --resume')
      }
      resolved = resolveWeb(options)
    })

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
