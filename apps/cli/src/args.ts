/**
 * Commander adapter for the `dsh` command-line entry: the one place argv is
 * parsed and routed to a mode. `bin.ts` switches on the returned discriminant
 * and dynamic-imports that mode's module. One program: the default (no
 * subcommand) is the TUI/headless surface with option-only flags;
 * `meta`, `upgrade`, and `web` are real subcommands; the experimental ones
 * (`meta`, `upgrade`) run only under the `--experimental` flag or
 * `DSH_EXPERIMENTAL=1`. Commander owns
 * `--help`/`--version` and parse
 * errors — it prints and exits at the point of failure (a domain failure routes through
 * `command.error`), so this returns only a resolved mode.
 * @module @deepseek-ai/dsh/args
 */

import { Command, CommanderError } from 'commander'

/**
 * Interactive TUI: the default mode. `--config` applies an overlay over the
 * shipped composition in place of the personal one, `--config-replace` boots a
 * file as the whole tree instead, and `--resume <id>` rehydrates a session.
 */
interface TuiInvocation {
  mode: 'tui'
  config?: string
  configReplace?: string
  resume?: string
}

/**
 * Print the composed config tree and exit, without booting: `--dump-config`
 * composes the shipped base, the surface overlay, and the `--config` or
 * personal overlay — exactly the layers that surface would boot;
 * `--dump-default-config` stops at the surface overlay (the shipped tree, no
 * user layer).
 */
interface DumpConfigInvocation {
  mode: 'dump-config'
  surface: 'tui' | 'web'
  /** Omit the `--config`/personal layer and print only the shipped composition. */
  defaultOnly: boolean
  /** The `--config` overlay to compose instead of the personal one. */
  config?: string
}

/** Headless one-shot: `dsh -p "task"`. */
interface HeadlessInvocation {
  mode: 'headless'
  prompt: string
}

/** Interactive fresh TUI over this harness checkout; accepts no default-surface options, only the experimental gate. */
interface MetaInvocation {
  mode: 'meta'
}

/**
 * Guided fresh-session entry: `dsh upgrade` seeds the first turn
 * with the `dsh-upgrade` skill. It always mints a
 * fresh session in the invoking directory and takes no options beyond the
 * experimental gate — `--resume`, `--config`, and `-p` are rejected as
 * mistyped, so there is nothing to carry.
 */
interface SkillSessionInvocation {
  mode: 'upgrade'
}

/**
 * Browser UI: `dsh web`. `host`/`port` are present only when the flag was
 * passed — pass-through overrides with no CLI default and no CLI validation:
 * the `dsh-host-webserver` schema (`host` a loopback/all-interfaces literal,
 * `port` a natural ≤ 65535) is the single source of both the default (the
 * shipped Web overlay value stands when a flag is absent) and validity (a bad
 * value fails loud at boot). `port` is `Number`-coerced only because the schema
 * wants a number, not a string. `dev` mounts the client HMR driver;
 * `workspaceRoot` is the parent directory for name-created workspaces.
 */
interface WebInvocation {
  mode: 'web'
  /** Overlay of loader patches applied over the shipped web composition. */
  config?: string
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
  | DumpConfigInvocation
  | HeadlessInvocation
  | MetaInvocation
  | SkillSessionInvocation
  | WebInvocation

/** Raw web-subcommand options straight from Commander. */
interface WebOptions {
  config?: string
  host?: string
  port?: string
  dev?: boolean
  workspaceRoot?: string
  trustedHost?: string[]
  dumpConfig?: boolean
  dumpDefaultConfig?: boolean
}

/**
 * Resolve the two dump flags for one surface, or return `undefined` when
 * neither was passed. Both flags together are contradictory (one includes the
 * user layer, the other excludes it) and fail loud through `error`.
 */
function resolveDump(
  surface: 'tui' | 'web',
  options: { config?: string; dumpConfig?: boolean; dumpDefaultConfig?: boolean },
  error: (message: string) => never,
): DumpConfigInvocation | undefined {
  if (options.dumpConfig !== true && options.dumpDefaultConfig !== true) return undefined
  if (options.dumpConfig === true && options.dumpDefaultConfig === true) {
    error('error: --dump-config and --dump-default-config are mutually exclusive')
  }
  const defaultOnly = options.dumpDefaultConfig === true
  if (defaultOnly && options.config !== undefined) {
    error('error: --dump-default-config prints the shipped tree and takes no --config')
  }
  return {
    mode: 'dump-config',
    surface,
    defaultOnly,
    ...options.config !== undefined && { config: options.config },
  }
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
    ...options.config !== undefined && { config: options.config },
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
 * @param experimentalEnv - whether the environment opts into experimental
 * subcommands (`DSH_EXPERIMENTAL=1`); the caller reads the process boundary.
 * @returns the resolved invocation (only reached on a valid, non-help invocation).
 */
export function parseDshArgs(argv: readonly string[], version: string, experimentalEnv: boolean): DshInvocation {
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
  dsh --resume <id>       continue a past session
`)
    .exitOverride()
    // Stop parent options at a subcommand boundary so `web --config` belongs to
    // Web while `--config ... web` remains a leaked default-surface option.
    .enablePositionalOptions()
    // Default surface: option-only (no positional), so `web` can be a real
    // subcommand without a positional collision.
    .option('-p, --prompt <task>', 'answer this task without the interactive UI, then exit')
    .option('--resume <id>', 'continue a past session by id')
    .option('--config <path>', 'apply this overlay of loader patches instead of the personal one')
    .option('--config-replace <path>', 'boot this file as the entire tree, ignoring the shipped and personal configuration')
    .option('--dump-config', 'print the composed config tree (base + surface + --config/personal overlay) and exit')
    .option('--dump-default-config', 'print the shipped config tree (base + surface overlay, no user layer) and exit')
    .action((options: {
      config?: string
      configReplace?: string
      prompt?: string
      resume?: string
      dumpConfig?: boolean
      dumpDefaultConfig?: boolean
    }) => {
      const dump = resolveDump('tui', options, message => program.error(message))
      if (dump !== undefined) {
        // The dump prints composition; a boot-only flag alongside it would be
        // silently ignored, so reject the mix loud.
        if (options.prompt !== undefined || options.resume !== undefined || options.configReplace !== undefined) {
          program.error('error: --dump-config/--dump-default-config take none of -p/--prompt, --resume, or --config-replace')
        }
        resolved = dump
        return
      }
      if (options.prompt !== undefined) {
        // A headless prompt owns the invocation; an empty task has nothing to
        // run, and --config/--resume are TUI inputs that must not silently
        // vanish from a headless run.
        if (options.prompt === '') program.error('error: --prompt needs a task')
        if (options.config !== undefined || options.configReplace !== undefined || options.resume !== undefined) {
          program.error('error: --prompt takes no --config, --config-replace, or --resume')
        }
        resolved = { mode: 'headless', prompt: options.prompt }
        return
      }
      // An empty --resume= id would silently start a fresh session downstream
      // (agent-loop treats '' as no-resume), so a mistyped resume must fail loud.
      if (options.resume === '') program.error('error: --resume needs a session id')
      // The two config flags are mutually exclusive: one layers over the shipped
      // tree, the other discards it, so accepting both would silently drop one.
      if (options.config !== undefined && options.configReplace !== undefined) {
        program.error('error: --config and --config-replace are mutually exclusive')
      }
      resolved = {
        mode: 'tui',
        ...options.config !== undefined && { config: options.config },
        ...options.configReplace !== undefined && { configReplace: options.configReplace },
        ...options.resume !== undefined && { resume: options.resume },
      }
    })

  // Commander parses the parent (default-surface) options on either side of a
  // subcommand into `program.opts()`. For a subcommand that shares none of them,
  // a leaked config/prompt/resume option is a mistyped invocation that must fail
  // loud rather than silently run and drop the input.
  const rejectParentOptions = (command: string): void => {
    const parent = program.opts<{
      config?: string
      configReplace?: string
      prompt?: string
      resume?: string
      dumpConfig?: boolean
      dumpDefaultConfig?: boolean
    }>()
    if (parent.config !== undefined || parent.configReplace !== undefined
      || parent.prompt !== undefined || parent.resume !== undefined
      || parent.dumpConfig !== undefined || parent.dumpDefaultConfig !== undefined) {
      program.error(`error: ${command} takes none of --config, --config-replace, -p/--prompt, --resume, --dump-config, or --dump-default-config`)
    }
  }

  // `meta` and `upgrade` are experimental: each runs only under its own
  // `--experimental` flag or an environment-wide `DSH_EXPERIMENTAL=1` opt-in,
  // and fails loud otherwise so the gate is never silently skipped.
  const requireExperimental = (command: string, flag: boolean | undefined): void => {
    if (flag !== true && !experimentalEnv) {
      program.error(`error: ${command} is experimental; pass --experimental or set DSH_EXPERIMENTAL=1`)
    }
  }

  // Registration order is the rendered help order, so daily use comes first
  // and the harness-development surfaces (`web --dev`, `meta`)
  // come last. `upgrade` is a guided fresh-session entry: beyond the
  // experimental gate it takes no options and always mints a fresh session,
  // so nothing is left to carry.
  program
    .command('upgrade')
    .description('update this dsh installation to the latest version (experimental)')
    .option('--experimental', 'acknowledge this subcommand is experimental')
    .action((options: { experimental?: boolean }) => {
      rejectParentOptions('upgrade')
      requireExperimental('upgrade', options.experimental)
      resolved = { mode: 'upgrade' }
    })

  // Host and port name no default: the CLI passes neither through when the flag
  // is absent, so the shipped Web overlay value stands and restating it here
  // would duplicate a fact this file does not own.
  const web = program.command('web').description('serve the browser UI on the configured host and port')
  web
    .option('--config <path>', 'apply this overlay of loader patches over the shipped configuration')
    .option('--host <host>', 'bind host; pass 0.0.0.0 to reach it from another machine')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--dev', 'developer mode: hot-reload the browser client')
    .option('--workspace-root <path>', 'parent directory for workspaces created from the browser UI')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .option('--dump-config', 'print the composed config tree (base + web + --config/personal overlay) and exit')
    .option('--dump-default-config', 'print the shipped config tree (base + web overlay, no user layer) and exit')
    .action((options: WebOptions) => {
      rejectParentOptions('web')
      const dump = resolveDump('web', options, message => program.error(message))
      if (dump !== undefined) {
        resolved = dump
        return
      }
      resolved = resolveWeb(options)
    })

  program
    .command('meta')
    .description('work on the dsh source that runs this command, from any directory (experimental)')
    .option('--experimental', 'acknowledge this subcommand is experimental')
    .action((options: { experimental?: boolean }) => {
      rejectParentOptions('meta')
      requireExperimental('meta', options.experimental)
      resolved = { mode: 'meta' }
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
