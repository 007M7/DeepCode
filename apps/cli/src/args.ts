/**
 * Commander adapter for the `dsh` command-line entry: the one place argv is
 * parsed and routed to a mode. `bin.ts` switches on the returned discriminant
 * and dynamic-imports that mode's module; each mode module then consumes the
 * already-parsed values instead of re-reading argv. Output is suppressed and
 * `exitOverride` is set so Commander never writes or exits on its own — every
 * outcome (including `--help`/`--version` and parse errors) is returned to the
 * caller as data. The `web` subcommand is a reserved first token dispatched to
 * its own parser, so root flags and `web` flags never share a grammar.
 * @module @deepseek-ai/dsh/args
 */

import { Command, CommanderError, InvalidArgumentError, Option } from 'commander'

/** The loopback host `dsh web` binds by default. */
export const LOOPBACK_HOST = '127.0.0.1'
/** The all-interfaces host `dsh web` accepts to expose the UI on the LAN. */
export const ALL_INTERFACES_HOST = '0.0.0.0'
const DEFAULT_WEB_PORT = 3080

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
 * Browser UI: `dsh web`. Host constrained to {@link LOOPBACK_HOST}/{@link ALL_INTERFACES_HOST};
 * port already coerced and range-checked; `dev` mounts the client HMR driver and bundle watch.
 */
interface WebInvocation {
  mode: 'web'
  host: string
  port: number
  dev: boolean
}

/** `--help` or `--version` requested: `bin.ts` prints `text` to stdout and exits 0. */
interface InfoInvocation {
  mode: 'help' | 'version'
  text: string
}

/** A parse error (unknown option, missing/invalid argument): `bin.ts` prints `message` to stderr and exits 1. */
interface ErrorInvocation {
  mode: 'error'
  message: string
}

/** The resolved `dsh` invocation: exactly one mode, all values parsed and validated. */
export type DshInvocation =
  | TuiInvocation
  | HeadlessInvocation
  | WebInvocation
  | InfoInvocation
  | ErrorInvocation

/** Coerce `--port` to an integer in 0–65535; a bad value fails loud as a parse error. */
function parsePort(raw: string): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidArgumentError(`invalid --port ${raw}`)
  }
  return port
}

/**
 * A configured `Command` under `exitOverride` with output captured into `sink`,
 * so `--help`, `--version`, and parse errors surface as thrown `CommanderError`s
 * (see {@link settle}) rather than writing to a stream or exiting.
 */
function program(name: string, version: string, sink: string[]): Command {
  return new Command()
    .name(name)
    .version(version, '-V, --version', 'output the version number')
    .exitOverride()
    .configureOutput({
      writeOut: chunk => void sink.push(chunk),
      writeErr: chunk => void sink.push(chunk),
    })
}

/**
 * Run `command.parse` and map its thrown `CommanderError` to an info/error
 * invocation, or `undefined` when the parse succeeded (the caller then reads the
 * parsed options).
 */
function settle(command: Command, argv: readonly string[], sink: string[]): InfoInvocation | ErrorInvocation | undefined {
  try {
    command.parse(argv, { from: 'user' })
    return undefined
  } catch (error) {
    /* v8 ignore next -- Commander only throws CommanderError from parse under exitOverride */
    if (!(error instanceof CommanderError)) throw error
    if (error.code === 'commander.helpDisplayed') return { mode: 'help', text: sink.join('') }
    if (error.code === 'commander.version') return { mode: 'version', text: sink.join('') }
    return { mode: 'error', message: error.message }
  }
}

/** Parse `dsh web` arguments (everything after the `web` token). */
function parseWeb(argv: readonly string[], version: string): DshInvocation {
  const sink: string[] = []
  const web = program('dsh web', version, sink)
    .description('serve the browser UI')
    .addOption(new Option('--host <host>', 'bind host').choices([LOOPBACK_HOST, ALL_INTERFACES_HOST]).default(LOOPBACK_HOST))
    .addOption(new Option('--port <port>', 'listen port').default(DEFAULT_WEB_PORT).argParser(parsePort))
    .option('--dev', 'mount the client HMR driver and watch plugin bundles for rebuilds')
  const settled = settle(web, argv, sink)
  if (settled !== undefined) return settled
  const { host, port, dev } = web.opts<{ host: string; port: number; dev?: boolean }>()
  return { mode: 'web', host, port, dev: dev ?? false }
}

/** Parse the default (TUI / headless) arguments: `[config]`, `-p/--prompt`, `--resume`. */
function parseRoot(argv: readonly string[], version: string): DshInvocation {
  const sink: string[] = []
  const root = program('dsh', version, sink)
    .description('dsh: interactive TUI, headless task, and browser UI')
    .argument('[config]', 'config to boot instead of the shipped default (TUI mode)')
    .option('-p, --prompt <task>', 'run one headless turn for this task, print the result, and exit')
    .option('--resume <id>', 'resume the persisted session with this id (TUI mode)')
  const settled = settle(root, argv, sink)
  if (settled !== undefined) return settled
  const { prompt, resume } = root.opts<{ prompt?: string; resume?: string }>()
  const config = root.processedArgs[0] as string | undefined

  if (prompt !== undefined) {
    // A headless prompt owns the invocation; an empty task has nothing to run.
    if (prompt === '') return { mode: 'error', message: "error: option '-p, --prompt <task>' must not be empty" }
    return { mode: 'headless', prompt }
  }
  // An empty `--resume=` id would silently start a fresh session downstream
  // (agent-loop treats '' as no-resume), so a mistyped resume must fail loud.
  if (resume === '') return { mode: 'error', message: "error: option '--resume <id>' must not be empty" }
  return {
    mode: 'tui',
    ...config !== undefined ? { config } : {},
    ...resume !== undefined ? { resume } : {},
  }
}

/**
 * Resolve the raw argv into a single {@link DshInvocation}. Never writes to a
 * stream and never exits; `--help`/`--version` and every parse error come back
 * as data for `bin.ts` to act on. A leading `web` token dispatches to the web
 * parser; everything else is the default TUI/headless grammar.
 * @param argv - the arguments after the node binary and script (`process.argv.slice(2)`).
 * @param version - the version string `--version` prints; read from this app's package.json.
 * @returns the resolved invocation, discriminated by `mode`.
 */
export function parseDshArgs(argv: readonly string[], version: string): DshInvocation {
  return argv[0] === 'web' ? parseWeb(argv.slice(1), version) : parseRoot(argv, version)
}
