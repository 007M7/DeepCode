/**
 * Commander adapter for the `dsh` command-line entry. The default command
 * boots one required `--config` overlay over the shipped base; `-p` selects
 * the one-shot headless path and `web` selects the browser application.
 * Commander owns help, version, and parse errors.
 * @module @deepseek-ai/dsh/args
 */

import { Command, CommanderError } from 'commander'

/** Boot a caller-selected overlay over the shipped base config. */
interface ConfigInvocation {
  mode: 'config'
  config: string
}

/** Print a composed config tree and exit without booting. */
interface DumpConfigInvocation {
  mode: 'dump-config'
  surface: 'config' | 'web'
  /** Omit every caller or personal layer and print the shipped tree. */
  defaultOnly: boolean
  /** Explicit overlay to compose over the base or Web surface. */
  config?: string
}

/** Headless one-shot: `dsh -p "task"`. */
interface HeadlessInvocation {
  mode: 'headless'
  prompt: string
}

/**
 * Browser UI: `dsh web`. Host and port remain unvalidated pass-throughs to
 * the webserver schema; absent values leave the shipped Web overlay intact.
 */
interface WebInvocation {
  mode: 'web'
  /** Overlay applied over the shipped Web composition instead of the personal one. */
  config?: string
  host?: string
  port?: number
  dev: boolean
  workspaceRoot?: string
  /** Extra authorities for the /api browser-trust fence. */
  trustedHosts?: string[]
}

/** The resolved `dsh` invocation. Help, version, and errors exit inside {@link parseDshArgs}. */
export type DshInvocation = ConfigInvocation | DumpConfigInvocation | HeadlessInvocation | WebInvocation

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

/** Resolve config-dump flags for one command shape. */
function resolveDump(
  surface: 'config' | 'web',
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
  if (surface === 'config' && !defaultOnly && options.config === undefined) {
    error('error: --dump-config requires --config <path>')
  }
  return {
    mode: 'dump-config',
    surface,
    defaultOnly,
    ...options.config !== undefined && { config: options.config },
  }
}

/** Narrow raw `web` options into a {@link WebInvocation}. */
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
 * Resolve argv into one invocation, or print and exit for help, version, or an
 * error.
 * @param argv - arguments after the Node binary and script.
 * @param version - version string printed by `--version`.
 * @returns the resolved invocation.
 */
export function parseDshArgs(argv: readonly string[], version: string): DshInvocation {
  let resolved: DshInvocation | undefined
  const program = new Command()
    .name('dsh')
    .version(version, '-V, --version', 'output the version number')
    .description('dsh: boot a DeepSeek Harness config overlay over the shipped base configuration.')
    .addHelpText('after', `
Examples:
  dsh --config ./app.cordis.yml  boot an overlay over the shipped base
  dsh -p "run the tests"         answer one task, print the result, and exit
  dsh web                       serve the browser UI
`)
    .exitOverride()
    .enablePositionalOptions()
    .option('-p, --prompt <task>', 'answer this task without an interactive UI, then exit')
    .option('--config <path>', 'overlay of loader patches to apply over the shipped base')
    .option('--dump-config', 'print the base plus --config overlay and exit')
    .option('--dump-default-config', 'print the shipped base config and exit')
    .action((options: {
      config?: string
      prompt?: string
      dumpConfig?: boolean
      dumpDefaultConfig?: boolean
    }) => {
      if (options.config === '') program.error('error: --config needs a path')
      const dump = resolveDump('config', options, message => program.error(message))
      if (dump !== undefined) {
        if (options.prompt !== undefined) {
          program.error('error: --dump-config/--dump-default-config take no -p/--prompt')
        }
        resolved = dump
        return
      }
      if (options.prompt !== undefined) {
        if (options.prompt === '') program.error('error: --prompt needs a task')
        if (options.config !== undefined) program.error('error: --prompt takes no --config')
        resolved = { mode: 'headless', prompt: options.prompt }
        return
      }
      const config = options.config ?? program.error('error: --config <path> is required')
      resolved = { mode: 'config', config }
    })

  /** Reject parent options that crossed a subcommand boundary. */
  const rejectParentOptions = (command: string): void => {
    const parent = program.opts<{
      config?: string
      prompt?: string
      dumpConfig?: boolean
      dumpDefaultConfig?: boolean
    }>()
    if (parent.config !== undefined || parent.prompt !== undefined
      || parent.dumpConfig !== undefined || parent.dumpDefaultConfig !== undefined) {
      program.error(`error: ${command} takes none of parent --config, -p/--prompt, --dump-config, or --dump-default-config`)
    }
  }

  const web = program.command('web').description('serve the browser UI on the configured host and port')
  web
    .option('--config <path>', 'apply this overlay of loader patches over the shipped Web configuration')
    .option('--host <host>', 'bind host; pass 0.0.0.0 to reach it from another machine')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--dev', 'mount the client-plugin HMR receiver (run pnpm run dev:web separately to rebuild bundles)')
    .option('--workspace-root <path>', 'parent directory for workspaces created from the browser UI')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .option('--dump-config', 'print the composed config tree (base + web + --config/personal overlay) and exit')
    .option('--dump-default-config', 'print the shipped config tree (base + web overlay, no user layer) and exit')
    .action((options: WebOptions) => {
      rejectParentOptions('web')
      if (options.config === '') program.error('error: --config needs a path')
      const dump = resolveDump('web', options, message => program.error(message))
      if (dump !== undefined) {
        resolved = dump
        return
      }
      resolved = resolveWeb(options)
    })

  try {
    program.parse(argv, { from: 'user' })
  } catch (error) {
    return process.exit(error instanceof CommanderError ? error.exitCode : 1)
  }
  /* v8 ignore next -- an action resolves or Commander throws */
  if (resolved === undefined) throw new Error('dsh: no invocation resolved')
  return resolved
}
