/**
 * The web app's command-line provider: it parses the `dsh --profile web` flag
 * family (`--host`, `--port`, `--dev`, `--trusted-host`) and its `--help`
 * text, then provides the immutable values as {@link WEB_STARTUP_SERVICE}.
 * Ordinary rows inject that service before reading it from lazy config.
 * @module @deepseek-ai/dsh-web-app/startup
 */

import { Command } from 'commander'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'

/** Stable Cordis plugin name. */
export const name = 'web-startup'

/** Services required before the flags can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this ordinary plugin and injected by flag-configured rows. */
export const WEB_STARTUP_SERVICE = 'webStartup'

/** What the web rows read from {@link WEB_STARTUP_SERVICE}. */
export interface WebStartupValues {
  /** `--host`, absent when the invocation did not name one. */
  host?: string
  /** `--port`, absent when the invocation did not name one. */
  port?: number
  /** Web runtime mode; `--dev` selects development, which also mounts the client-plugin reload chain. */
  mode: 'production' | 'development'
  /** Explicit `--trusted-host` authorities, in argument order. */
  trustedHosts: string[]
}

/** The web flag family, as commander parsed it. */
interface WebOptions {
  host?: string
  port?: string
  dev?: boolean
  trustedHost?: string[]
}

/**
 * This app's command: its flags, its description, and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function webCommand(): Command {
  return new Command()
    .name('dsh --profile web')
    .description('Serve the DeepSeek Harness browser UI.')
    .helpOption('-h, --help', 'show this help')
    .option('--host <host>', 'bind host; pass 0.0.0.0 to reach it from another machine')
    .option('--port <port>', 'listen port; pass 0 to let the OS pick a free one')
    .option('--dev', 'mount the client-plugin HMR receiver (run pnpm run dev:web separately to rebuild bundles)')
    .option('--trusted-host <authority...>', 'extra authority the /api browser-trust fence accepts (host or host:port; repeatable)')
    .addHelpText('after', `
Examples:
  dsh --profile web                          serve on the composed host and port
  dsh --profile web --port 8080              serve on another port
  dsh --profile web --host 0.0.0.0           reach it from another machine on the LAN
  dsh --profile web --dev                    mount the client-plugin HMR receiver
`)
}

/**
 * Turn the parsed flags into the value injected rows read.
 * @param program - the parsed web command.
 * @returns this invocation's immutable Web options.
 */
function planWebStartup(program: Command): WebStartupValues {
  const options = program.opts<WebOptions>()
  if (options.port !== undefined && !/^\d+$/.test(options.port)) {
    program.error(`error: --port must be a number, got ${JSON.stringify(options.port)}`)
  }
  return {
    ...options.host !== undefined && { host: options.host },
    ...options.port !== undefined && { port: Number(options.port) },
    mode: options.dev === true ? 'development' : 'production',
    trustedHosts: options.trustedHost ?? [],
  }
}

/**
 * Parse and provide the Web invocation as an ordinary Cordis service.
 * @param ctx - plugin context carrying the command line.
 * @returns nothing once values are provided, or when the command requested exit.
 */
export function apply(ctx: Context): void {
  const values = parseCmdline(ctx, webCommand(), planWebStartup)
  if (values !== undefined) ctx.provide(WEB_STARTUP_SERVICE, values)
}
