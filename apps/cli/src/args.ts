/**
 * Commander adapter for the `dsh` command-line entry: the one place argv is
 * parsed and routed to a mode. `bin.ts` switches on the returned discriminant
 * and dynamic-imports that mode's module. Commander owns `--help`/`--version`
 * and parse errors: it prints and exits at the point of failure (a domain
 * failure routes through `command.error`), so this returns only a resolved mode.
 * The `web` subcommand is a reserved first token dispatched to its own parser.
 * @module @deepseek-ai/dsh/args
 */

import { Command, CommanderError } from 'commander'

/** The loopback host `dsh web` binds by default. */
export const LOOPBACK_HOST = '127.0.0.1'
/** The all-interfaces host `dsh web` accepts to expose the UI on the LAN. */
export const ALL_INTERFACES_HOST = '0.0.0.0'

/** Interactive TUI: the default mode. Optional positional config and `--resume <id>`. */
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

/** A `Command` under `exitOverride`, so {@link parseDshArgs} owns the exit, named for its usage line. */
function program(name: string, version: string): Command {
  return new Command().name(name).version(version, '-V, --version', 'output the version number').exitOverride()
}

/** Parse `dsh web` arguments (everything after the `web` token). */
function parseWeb(argv: readonly string[], version: string): WebInvocation {
  // No Commander `default`: an absent flag leaves the option undefined so the
  // shipped cordis.yml value stands (the single source of the host/port default).
  const web = program('dsh web', version)
    .description('serve the browser UI (host/port default to the shipped config)')
    .option('--host <host>', `bind host (${LOOPBACK_HOST} or ${ALL_INTERFACES_HOST})`)
    .option('--port <port>', 'listen port (0 requests an OS-assigned port)')
    .option('--dev', 'mount the client HMR driver and watch plugin bundles for rebuilds')
  web.parse(argv, { from: 'user' })
  const { host, port, dev } = web.opts<{ host?: string; port?: string; dev?: boolean }>()
  if (host !== undefined && host !== LOOPBACK_HOST && host !== ALL_INTERFACES_HOST) {
    web.error(`error: --host must be ${LOOPBACK_HOST} or ${ALL_INTERFACES_HOST}`)
  }
  let portNumber: number | undefined
  if (port !== undefined) {
    portNumber = Number(port)
    if (!/^\d+$/.test(port) || !Number.isInteger(portNumber) || portNumber > 65535) {
      web.error('error: --port must be an integer in 0-65535')
    }
  }
  return {
    mode: 'web',
    ...host !== undefined && { host },
    ...portNumber !== undefined && { port: portNumber },
    dev: dev === true,
  }
}

/** Parse the default (TUI / headless) arguments: `[config]`, `-p/--prompt`, `--resume`. */
function parseRoot(argv: readonly string[], version: string): DshInvocation {
  const root = program('dsh', version)
    .description('dsh: interactive TUI, headless task, and browser UI')
    .argument('[config]', 'config to boot instead of the shipped default (TUI mode)')
    .option('-p, --prompt <task>', 'run one headless turn for this task, print the result, and exit')
    .option('--resume <id>', 'resume the persisted session with this id (TUI mode)')
    // Disclose the web mode in `dsh --help`; a real `web` subcommand would
    // hijack the `[config]` positional. `parseDshArgs` intercepts `web` first.
    .addHelpText('after', '\nCommands:\n  web            serve the browser UI (run `dsh web --help`)')
  root.parse(argv, { from: 'user' })
  const { prompt, resume } = root.opts<{ prompt?: string; resume?: string }>()
  const config = root.processedArgs[0] as string | undefined

  if (prompt !== undefined) {
    // A headless prompt owns the invocation; an empty task has nothing to run,
    // and a config or --resume alongside it is a TUI input that must not
    // silently vanish from the run.
    if (prompt === '') root.error('error: --prompt needs a task')
    if (config !== undefined || resume !== undefined) root.error('error: --prompt takes no config or --resume')
    return { mode: 'headless', prompt }
  }
  // An empty `--resume=` id would silently start a fresh session downstream
  // (agent-loop treats '' as no-resume), so a mistyped resume must fail loud.
  if (resume === '') root.error('error: --resume needs a session id')
  return { mode: 'tui', ...config !== undefined && { config }, ...resume !== undefined && { resume } }
}

/**
 * Resolve the raw argv into a {@link DshInvocation}, or print and exit for
 * `--help`/`--version`/a parse error. A leading `web` token dispatches to the
 * web parser; everything else is the default TUI/headless grammar.
 * @param argv - the arguments after the node binary and script (`process.argv.slice(2)`).
 * @param version - the version string `--version` prints; read from this app's package.json.
 * @returns the resolved invocation (only reached on a valid, non-help invocation).
 */
export function parseDshArgs(argv: readonly string[], version: string): DshInvocation {
  try {
    return argv[0] === 'web' ? parseWeb(argv.slice(1), version) : parseRoot(argv, version)
  } catch (error) {
    // Commander printed help/version/the error under `exitOverride`; exit with
    // the code it chose (0 for help/version, 1 for a parse or domain error).
    /* v8 ignore next -- Commander only throws CommanderError from parse/error under exitOverride */
    return process.exit(error instanceof CommanderError ? error.exitCode : 1)
  }
}
