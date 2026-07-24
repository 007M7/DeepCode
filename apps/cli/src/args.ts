/**
 * Commander adapter for the `dsh` command-line entry: the one place argv is
 * parsed and routed to a mode. `bin.ts` switches on the returned discriminant
 * and dynamic-imports that mode's module; each mode module then consumes the
 * already-parsed values instead of re-reading argv. Output is suppressed and
 * `exitOverride` is set so Commander never writes or exits on its own — every
 * outcome (including `--help`/`--version` and parse errors) is returned to the
 * caller as data.
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

/** Browser UI: `dsh web`. Host constrained to {@link LOOPBACK_HOST}/{@link ALL_INTERFACES_HOST}; port already coerced and range-checked. */
interface WebInvocation {
  mode: 'web'
  host: string
  port: number
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

/** Raw Commander option bag for the root command before it is narrowed to a mode. */
interface RootOptions {
  prompt?: string
  resume?: string
}

/** Commander option bag for the `web` subcommand after `--port` coercion. */
interface WebOptions {
  host: string
  port: number
}

/**
 * Coerce `--port` to an integer in 0–65535; a bad value throws
 * {@link InvalidArgumentError}, which Commander reports as a parse error the
 * adapter returns as an {@link ErrorInvocation}.
 */
function parsePort(raw: string): number {
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new InvalidArgumentError(`invalid --port ${raw}`)
  }
  return port
}

/** Reject an empty `--prompt` task; an empty headless prompt has nothing to run. */
function parsePrompt(raw: string): string {
  if (raw === '') throw new InvalidArgumentError("option '-p, --prompt <task>' must not be empty")
  return raw
}

/**
 * Validate a `--resume` value: reject an empty id and a repeated flag. Both are
 * mistypes that must fail loud, never silently start a fresh session or keep
 * only the last id. `previous` is the value from an earlier `--resume` on the
 * same invocation (Commander threads it in), so a second occurrence is caught.
 */
function parseResume(raw: string, previous: string | undefined): string {
  if (previous !== undefined) throw new InvalidArgumentError("option '--resume <id>' may be given only once")
  if (raw === '') throw new InvalidArgumentError("option '--resume <id>' must not be empty")
  return raw
}

/**
 * Resolve the raw argv into a single {@link DshInvocation}. Never writes to a
 * stream and never exits; `--help`/`--version` and every parse error come back
 * as data for `bin.ts` to act on.
 * @param argv - the arguments after the node binary and script (`process.argv.slice(2)`).
 * @param version - the version string `--version` prints; read from this app's package.json.
 * @returns the resolved invocation, discriminated by `mode`.
 */
export function parseDshArgs(argv: readonly string[], version: string): DshInvocation {
  let resolved: DshInvocation | undefined
  const output: string[] = []

  const program = new Command()
    .name('dsh')
    .description('dsh: interactive TUI, headless task, and browser UI')
    .version(version, '-V, --version', 'output the version number')
    .exitOverride()
    .configureOutput({
      writeOut: chunk => void output.push(chunk),
      writeErr: chunk => void output.push(chunk),
    })

  // Positional options keep `dsh -p x web` from routing to the `web`
  // subcommand: a token after a root option is a positional, not a command.
  program
    .enablePositionalOptions()
    .argument('[config]', 'config to boot instead of the shipped default (TUI mode)')
    .addOption(new Option('-p, --prompt <task>', 'run one headless turn for this task, print the result, and exit').argParser(parsePrompt))
    .addOption(new Option('--resume <id>', 'resume the persisted session with this id (TUI mode)').argParser(parseResume))
    .action((config: string | undefined, options: RootOptions) => {
      if (options.prompt !== undefined) {
        // A headless prompt owns the invocation; a config positional is meaningless there.
        if (config !== undefined) {
          throw new InvalidArgumentError(`error: --prompt takes no config argument (got '${config}')`)
        }
        resolved = { mode: 'headless', prompt: options.prompt }
        return
      }
      resolved = {
        mode: 'tui',
        ...config !== undefined ? { config } : {},
        ...options.resume !== undefined ? { resume: options.resume } : {},
      }
    })

  program
    .command('web')
    .description('serve the browser UI')
    .addOption(
      new Option('--host <host>', 'bind host')
        .choices([LOOPBACK_HOST, ALL_INTERFACES_HOST])
        .default(LOOPBACK_HOST),
    )
    .addOption(
      new Option('--port <port>', 'listen port').default(DEFAULT_WEB_PORT).argParser(parsePort),
    )
    .action((options: WebOptions, command: Command) => {
      // Root options placed before `web` (`dsh -p x web`) leak onto the parent;
      // reject them so a misplaced flag fails loud instead of silently serving.
      const leaked = command.parent?.opts<RootOptions>()
      if (leaked?.prompt !== undefined || leaked?.resume !== undefined) {
        throw new InvalidArgumentError('error: web takes no --prompt or --resume; place web first')
      }
      resolved = { mode: 'web', host: options.host, port: options.port }
    })

  try {
    program.parse(argv, { from: 'user' })
  } catch (error) {
    /* v8 ignore next -- Commander only throws CommanderError from parse under exitOverride */
    if (!(error instanceof CommanderError)) throw error
    if (error.code === 'commander.helpDisplayed') return { mode: 'help', text: output.join('') }
    if (error.code === 'commander.version') return { mode: 'version', text: output.join('') }
    // Every other CommanderError is a parse failure; its message is the diagnostic.
    return { mode: 'error', message: error.message }
  }

  /* v8 ignore next -- one action always resolves the invocation or parse throws above */
  if (resolved === undefined) throw new Error('dsh: argument parsing did not resolve a mode')
  return resolved
}
