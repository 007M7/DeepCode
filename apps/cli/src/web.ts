/**
 * `dsh web` — thin bin over the config-tree boot: run AppCLIEntry with the
 * already-parsed host/port/dev, print the URL line, wire signals. All
 * composition lives in the shared base plus Web overlay; all boot glue lives in AppCLIEntry. Host and
 * port are unvalidated pass-through overrides — the `dsh-host-webserver` schema
 * gates them at boot.
 */

import { fileURLToPath } from 'node:url'
import type { Context } from 'cordis'
import { addHarnessSourceSection, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tool-bash'
import { AppCLIEntry } from './app-cli-entry.ts'

// The shared core every `dsh` surface mounts, plus this surface's overlay over it.
const BASE_CONFIG = fileURLToPath(new URL('../config/base.cordis.yml', import.meta.url))
const WEB_OVERLAY = fileURLToPath(new URL('../config/web.cordis.yml', import.meta.url))
const SOURCE_ROOT = fileURLToPath(new URL('../../..', import.meta.url))

const DSH_WEB_URL = 'DSH_WEB_URL' as const
const DSH_WEB_MODE = 'DSH_WEB_MODE' as const

type WebMode = 'production' | 'development'

/** Model-visible orientation and acceptance boundary for sessions created through `dsh web`. */
function webSurfacePrompt(webUrl: string, mode: WebMode): string {
  const updateContract = mode === 'development'
    ? 'This Web process was launched with `dsh web --dev`, so its client-plugin HMR receiver is active. '
      + 'No-refresh updates occur only when `pnpm run dev:web` is also running from this same checkout to rebuild client-plugin bundles; verify that watcher before promising automatic updates. '
      + 'Client-plugin changes then reload automatically, while apps/web shell and other plain-package changes still require a rebuild and page refresh. '
    : 'This Web process was launched without `--dev`, so HMR is inactive: rebuild the affected Web artifacts and verify this existing URL after a page refresh. '
      + 'If the user wants no-refresh client-plugin updates, explain that this GUI must be restarted with `dsh web --dev` and `pnpm run dev:web` must also run from this same checkout; do not present either command alone as sufficient. '
  return `You are interacting with the user through the DeepSeek Harness Web GUI at ${webUrl}. `
    + 'When the user refers to "this page", "this GUI", or "this app" without naming another target, they mean this GUI. '
    + 'The browser provides no implicit DOM, route, or screenshot context. '
    + updateContract
    + 'Starting another server does not update this GUI. '
    + 'The apps/web Vite entry builds the shell but is not a standalone application because only dsh web injects window.__DSH_BOOT__. '
    + 'Do not start a replacement server unless the user asks; if one is needed, use a managed background task and verify its exact URL.'
}

/**
 * Add launcher-owned source, Web-surface orientation, and the shell-visible
 * canonical URL after the shared config tree settles. The request header logs
 * the model-visible sections; each bash execution receives the same URL through
 * the managed environment.
 * @param ctx - settled Web application context.
 * @param sourceRoot - absolute checkout root resolved from the launcher module.
 * @param webUrl - canonical loopback URL printed by this Web process.
 * @param mode - whether this process mounted the client-plugin HMR receiver.
 */
export function installWebPromptContext(ctx: Context, sourceRoot: string, webUrl: string, mode: WebMode): void {
  const systemPrompt = ctx.get('systemPrompt')
  if (systemPrompt === undefined) throw new Error('dsh web: systemPrompt service missing after settled boot')
  const bashEnv = ctx.get('bashEnv')
  if (bashEnv === undefined) throw new Error('dsh web: bashEnv service missing after settled boot')
  addHarnessSourceSection(ctx, sourceRoot)
  systemPrompt.section({ name: 'app:web-surface', order: -98, text: webSurfacePrompt(webUrl, mode) })
  bashEnv.register({
    name: 'web-runtime',
    variables: {
      [DSH_WEB_URL]: { description: 'Canonical local URL of the DeepSeek Harness Web GUI serving this session.' },
      [DSH_WEB_MODE]: { description: 'Web runtime mode: production, or development when the client-plugin HMR receiver is active.' },
    },
    resolve: () => ({ [DSH_WEB_URL]: webUrl, [DSH_WEB_MODE]: mode }),
  })
}

// Display-only mirror of the webserver schema's loopback host: the address the
// local URL always prints. Not a source of truth — the schema is.
const LOOPBACK_HOST = '127.0.0.1'

/**
 * Serve the browser UI from the shipped config tree. `host`/`port` are passed
 * through only when the flag was given; absent, the shipped Web overlay value stands.
 * @param host - the bind host, or `undefined` to keep the config default.
 * @param port - the listen port (`0` requests an OS-assigned port), or `undefined` to keep the config default.
 * @param dev - mount the client HMR receiver; `pnpm run dev:web` separately rebuilds watched plugin bundles.
 * @param workspaceRoot - parent directory for name-created workspaces, or `undefined` for the gateway's cwd fallback.
 * @param trustedHosts - extra authorities for the /api browser-trust fence, or `undefined` for the derived LAN literals alone.
 * @param config - an overlay of loader patches applied over the shipped web
 * composition instead of `$DSH_HOME/config.yaml`, or `undefined` to use the
 * personal overlay; already parsed from `--config`.
 */
export async function runWeb(
  host: string | undefined,
  port: number | undefined,
  dev: boolean,
  workspaceRoot: string | undefined,
  trustedHosts: string[] | undefined,
  config?: string,
): Promise<void> {
  const entry = new AppCLIEntry({
    configPath: BASE_CONFIG,
    overlayPath: WEB_OVERLAY,
    ...config !== undefined && { extraOverlayPath: resolveConfigPath(config, undefined) },
    dev,
    ...host !== undefined && { host },
    ...port !== undefined && { port },
    ...workspaceRoot !== undefined && { workspaceRoot },
    ...trustedHosts !== undefined && { trustedHosts },
  })
  const { ctx, port: boundPort } = await entry.run()
  const localUrl = `http://${LOOPBACK_HOST}:${boundPort}`
  const mode: WebMode = dev ? 'development' : 'production'
  installWebPromptContext(ctx, SOURCE_ROOT, localUrl, mode)

  let exiting = false
  const shutdown = (code: number): void => {
    if (exiting) return
    exiting = true
    void Promise.resolve(ctx.fiber.dispose()).finally(() => { process.exit(code) })
  }

  // Install shutdown handling before publishing readiness: supervisors may
  // send a signal as soon as they observe the URL line.
  process.on('SIGTERM', () => { shutdown(0) })
  process.on('SIGINT', () => { shutdown(130) })

  // The entry's boot-time snapshot, not a fresh sample: the printed LAN URL
  // must name an address the /api trust fence was configured with.
  const lanCandidate = entry.lanAddresses[0]
  console.log(`dsh web: ${localUrl}${lanCandidate === undefined ? '' : ` (LAN: http://${lanCandidate}:${boundPort})`}`)
}
