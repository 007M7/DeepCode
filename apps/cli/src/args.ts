/**
 * Commander adapter for the `dsh` command-line entry: the one place argv is
 * parsed and routed to a mode. `bin.ts` switches on the returned discriminant
 * and dynamic-imports that mode's module. One program: the default (no
 * subcommand) is the TUI/headless surface with option-only flags; `meta` and
 * `web` are real subcommands. Commander owns `--help`/`--version` and parse
 * errors — it prints and exits at the point of failure (a domain failure routes through
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
 * Interactive TUI over this harness checkout: `dsh meta`. Identical to
 * {@link TuiInvocation} except the workspace is the launcher's own source tree
 * rather than the invoking directory. No `--config`: booting a foreign tree
 * against the harness workspace is the `--config` case, not this one.
 */
interface MetaInvocation {
  mode: 'meta'
  resume?: string
}

/**
 * Guided fresh-session entries: `dsh migrate` seeds the first turn with the
 * `dsh-migrate` skill, `dsh upgrade` with `dsh-upgrade`. Each always mints a
 * fresh session in the invoking directory and takes no options — `--resume`,
 * `--config`, and `-p` are rejected as mistyped, so there is nothing to carry.
 */
interface SkillSessionInvocation {
  mode: 'migrate' | 'upgrade'
}

/**
 * List live sessions: `dsh list-sessions` (alias `dsh ps`). A read-only surface
 * that boots no agent tree — it reads the cross-process session registry and
 * exits. `json` selects the machine-readable form over the human table. There
 * is no workspace filter: the listing is always every live session, whatever
 * directory it runs in.
 */
interface ListSessionsInvocation {
  mode: 'list-sessions'
  json: boolean
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
  /** Extra authorities for the /api browser-trust fence (`host` or `host:port`); LAN IP literals are derived, not listed here. */
  trustedHosts?: string[]
}

/** The resolved `dsh` invocation: exactly one mode. `--help`/`--version`/errors exit inside {@link parseDshArgs}. */
export type DshInvocation =
  | TuiInvocation
  | HeadlessInvocation
  | MetaInvocation
  | SkillSessionInvocation
  | ListSessionsInvocation
  | WebInvocation

/** Raw web-subcommand options straight from Commander. */
interface WebOptions {
  host?: string
  port?: string
  dev?: boolean
  workspaceRoot?: string
  trustedHost?: string[]
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
    ...options.trustedHost !== undefined && { trustedHosts: options.trustedHost },
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
    .description('dsh: DeepSeek Harness — an interactive coding agent for your terminal.\nRun `dsh` with no arguments to start a session in the current directory.')
    // The default surface takes no positional task, so `dsh "task"` fails
    // commander's arity check with no hint; these examples are where a first
    // reader learns the entry points and that a one-shot task rides `-p`.
    .addHelpText('after', `
Examples:
  dsh                     start an interactive session in this directory
  dsh -p "run the tests"  answer one task, print the result, and exit
  dsh --resume <id>       continue a past session (list ids with \`dsh ps\`)
`)
    .exitOverride()
    // Default surface: option-only (no positional), so `web` can be a real
    // subcommand without a positional collision.
    .option('-p, --prompt <task>', 'answer this task without the interactive UI, then exit')
    .option('--resume <id>', 'continue a past session by id (list ids with `dsh ps`)')
    .option('--config <path>', 'start with an alternate plugin configuration file')
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

  // Commander parses the parent (default-surface) options on either side of a
  // subcommand into `program.opts()`. For a subcommand that shares none of them,
  // a leaked `--config`/`-p`/`--resume` is a mistyped invocation that must fail
  // loud rather than silently run and drop the input.
  const rejectParentOptions = (command: string): void => {
    const parent = program.opts<{ config?: string; prompt?: string; resume?: string }>()
    if (parent.config !== undefined || parent.prompt !== undefined || parent.resume !== undefined) {
      program.error(`error: ${command} takes none of --config, -p/--prompt, or --resume`)
    }
  }

  // Registration order is the rendered help order, so daily use comes first
  // and the harness-development surfaces (`web --dev`, `meta`) come last.
  // `migrate` and `upgrade` are guided fresh-session entries: they take no
  // options and always mint a fresh session, so nothing is left to carry. Each
  // description names the outcome, not the skill the first turn invokes.
  const guided = {
    migrate: 'import settings from another coding agent (Claude Code, Codex, opencode)',
    upgrade: 'update this dsh installation to the latest version',
  } as const
  for (const mode of ['migrate', 'upgrade'] as const) {
    program
      .command(mode)
      .description(guided[mode])
      .action(() => {
        rejectParentOptions(mode)
        resolved = { mode }
      })
  }

  program
    .command('list-sessions')
    .alias('ps')
    .description('list sessions running right now')
    .option('--json', 'print the records as a JSON array instead of a table')
    .action((options: { json?: boolean }) => {
      rejectParentOptions('list-sessions')
      resolved = { mode: 'list-sessions', json: options.json === true }
    })

  // Host and port name no default: the CLI passes neither through when the flag
  // is absent, so the shipped `cordis.yml` value stands and restating it here
  // would duplicate a fact this file does not own.
  const web = program.command('web').description('serve the browser UI on the configured host and port')
  web
    .option('--host <host>', 'bind host; pass 0.0.0.0 to reach it from another machine')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--dev', 'developer mode: hot-reload the browser client')
    .option('--workspace-root <path>', 'parent directory for workspaces created from the browser UI')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .action((options: WebOptions) => {
      rejectParentOptions('web')
      resolved = resolveWeb(options)
    })

  // `--resume` is NOT redeclared here: an option a subcommand shares with its
  // parent parses into `program.opts()` and leaves the subcommand's own options
  // empty, so redeclaring it would silently drop the id. Commander therefore
  // omits it from this subcommand's option list, hence the trailing help text.
  program
    .command('meta')
    .description('work on the dsh source that runs this command, from any directory')
    .addHelpText('after', '\nAccepts --resume <id> to resume a persisted session from this checkout.\n')
    .action(() => {
      // Commander parses the parent (default-surface) options on either side of
      // the subcommand into `program.opts()`. `meta` accepts only `--resume`, so
      // a leaked `--config`/`-p` is a mistyped invocation that must fail loud
      // rather than silently be dropped.
      const parent = program.opts<{ config?: string; prompt?: string; resume?: string }>()
      if (parent.config !== undefined || parent.prompt !== undefined) {
        program.error('error: meta takes neither --config nor -p/--prompt')
      }
      // Same reason as the default surface: an empty id would start a fresh
      // session downstream instead of failing the mistyped resume.
      if (parent.resume === '') program.error('error: --resume needs a session id')
      resolved = { mode: 'meta', ...parent.resume !== undefined && { resume: parent.resume } }
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
