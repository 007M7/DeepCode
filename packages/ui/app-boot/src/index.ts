/**
 * Shared boot glue for the app bins (`dsh-stdio-agent`, `dsh-acp-agent`): load
 * the gitignored `.env`, install the fail-loud Loader guards, resolve the
 * config path (snapshot-aware), and drive the cordis Loader against a leaf
 * `cordis.yml` until the whole tree has settled. Each bin stays a thin
 * self-executing composition over these helpers, parameterized by its
 * diagnostic prefix; the loader-failure lore lives here, once, under the
 * per-file coverage gate.
 *
 * Two failure classes the guards handle:
 *
 * - `loader.await()` does NOT rethrow a load error (`EntryTree.await()` uses
 *   `Promise.allSettled`, which swallows rejections). A plugin whose
 *   `[Service.init]` throws surfaces as an unhandled rejection AFTER `boot()`
 *   resolves — Node's default handler already exits non-zero, and
 *   {@link installFailLoud} replaces the noisy dump with one labelled stderr
 *   line and a guaranteed `exit(1)`.
 * - A plugin module that fails to IMPORT is caught and only LOGGED by the
 *   cordis Loader (`entry._init`), leaving the entry with no `fiber` and
 *   producing no rejection — the process would otherwise exit 0 with a usable
 *   config typo reported only as a log line; {@link assertEntriesLoaded} makes
 *   `boot()` reject on any such entry instead of returning a half-empty
 *   context.
 *
 * @module @deepseek-ai/dsh-app-boot
 */

import { pathToFileURL } from 'node:url'
import { basename, dirname, resolve } from 'node:path'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

/**
 * Resolve the config to boot, honoring snapshot REPLAY. Given the requested
 * path, replay mode swaps a `cordis.yml` basename for `cordis.snapshot.yml` in
 * the SAME directory (the keyless replay tree). Other modes — including no
 * snapshot mode at all — use the path as-is. Returns an absolute path resolved
 * from `cwd`.
 * @param configPath - the requested config path (absolute, or relative to `cwd`).
 * @param snapshotMode - the bin's `$DSH_SNAPSHOT` value; only `'replay'` swaps the basename.
 * @param cwd - the base a relative `configPath` resolves against.
 * @returns the absolute path of the config to boot.
 */
export function resolveConfigPath(
  configPath: string, snapshotMode: string | undefined, cwd: string = process.cwd(),
): string {
  const absolute = resolve(cwd, configPath)
  if (snapshotMode !== 'replay') return absolute
  const dir = dirname(absolute)
  const replayName = basename(absolute).replace(/cordis\.ya?ml$/, 'cordis.snapshot.yml')
  return resolve(dir, replayName)
}

/**
 * Load `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` from a gitignored `.env` in
 * `dir` (Node native `process.loadEnvFile`). An absent file is fine — the
 * environment may already carry the variables; the leaf `cordis.yml` reads
 * them via the `!!js` tag. A present-but-unreadable `.env` is a real
 * misconfiguration: surface it via `warn` (one line, default stderr) rather
 * than silently running with the wrong environment.
 * @param binName - the diagnostic prefix on the warn line.
 * @param dir - the directory whose `.env` to load.
 * @param warn - sink for the one-line misconfiguration diagnostic.
 */
export function loadEnv(
  binName: string, dir: string = process.cwd(),
  warn: (line: string) => void = line => void process.stderr.write(line),
): void {
  try {
    process.loadEnvFile(resolve(dir, '.env'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      warn(`${binName}: failed to load .env: ${String(error)}\n`)
    }
    // ENOENT (no .env) is fine — rely on the ambient environment.
  }
}

/**
 * The slice of `process` {@link installFailLoud} needs — injectable so tests
 * exercise the handler without registering on (or exiting) the real process.
 */
export interface FailLoudProcess {
  on(event: 'unhandledRejection', handler: (err: unknown) => void): unknown
  off(event: 'unhandledRejection', handler: (err: unknown) => void): unknown
  stderr: { write(chunk: string): unknown }
  exit(code: number): void
}

/**
 * Make a load failure fail loud with a clear message on stderr. Covers the
 * failure path {@link assertEntriesLoaded} cannot: an include whose
 * `[Service.init]` throws (e.g. a config FILE that does not exist in a real
 * directory) surfaces as an unhandled promise rejection AFTER `boot()`
 * resolves. Node's default handler already exits non-zero on an unhandled
 * rejection; this replaces the noisy stack dump with a single labelled line on
 * STDERR (never stdout — for the ACP bin that channel carries JSON-RPC) and
 * guarantees `exit(1)`. Install before `boot()`. Returns the uninstaller
 * (tests use it; the bins run until exit and never do).
 * @param binName - the diagnostic prefix on the fatal-failure line.
 * @param proc - the process slice to register on; tests inject a fake.
 * @returns the uninstaller that removes the rejection handler.
 */
export function installFailLoud(binName: string, proc: FailLoudProcess = process): () => void {
  const handler = (err: unknown): void => {
    proc.stderr.write(`${binName}: fatal load failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    proc.exit(1)
  }
  proc.on('unhandledRejection', handler)
  return () => void proc.off('unhandledRejection', handler)
}

/**
 * After the tree settles, assert every loader entry actually started. A
 * started entry has a `fiber`; an entry with `fiber === undefined` after the
 * tree settled never loaded (its module failed to import), so throw and let
 * `boot()` reject instead of returning a half-empty context. A `disabled`
 * entry is the one legitimate fiber-less state: `Entry.refresh()` deliberately
 * skips `init()` for it — a valid "plugin turned off" config, not a failed
 * import — so it is excluded.
 * @param ctx - the settled context whose loader entries to audit.
 * @param binName - the diagnostic prefix on the thrown error.
 */
export function assertEntriesLoaded(ctx: Context, binName: string): void {
  const failed = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
  if (failed.length > 0) {
    const names = failed.map(entry => entry.options.name).join(', ')
    throw new Error(`${binName}: plugin(s) failed to load: ${names} (see the error(s) logged above)`)
  }
}

/**
 * Boot the Loader against `absoluteConfigPath` and return the root context
 * once the whole tree has settled. The include is handed the config's ABSOLUTE
 * `file://` URL as its `path`, so resolution never depends on `ctx.baseUrl`
 * (an absolute URL ignores the base) and can never fall back to the cwd;
 * `baseUrl` is still pinned to the config's directory so the config's OWN
 * relative plugin/include paths resolve against it.
 *
 * The `await ctx.loader.await()` is load-bearing: `loader.create()` returns
 * once the include ENTRY is registered, but the include then loads its child
 * plugins asynchronously — without awaiting the tree, `boot()` would resolve
 * while the app's plugins are still mounting, and a CLI process with no
 * attached handles yet exits 0 silently. Failures surface two ways: an entry
 * whose module failed to import is caught here by {@link assertEntriesLoaded}
 * (this `boot()` rejects); an init that THROWS surfaces as an unhandled
 * rejection caught by {@link installFailLoud} (installed by the bin first).
 *
 * Bare plugin specifiers in the config (`@deepseek-ai/dsh-*`, npm packages)
 * are resolved by the cordis Loader's internal module loader, which is only
 * active under `node --expose-internals`; a consumer running a built bin must
 * pass that flag (or install the plugins where node hoists them). Relative
 * specifiers resolve against the config directory with no flag.
 * @param binName - the diagnostic prefix for load-failure errors.
 * @param absoluteConfigPath - the config to include; must already be absolute
 * (see {@link resolveConfigPath}).
 * @returns the root context once every entry has started.
 */
export async function boot(binName: string, absoluteConfigPath: string): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
  await ctx.plugin(Loader)
  await ctx.loader.create({
    name: '@cordisjs/plugin-include',
    config: { path: pathToFileURL(absoluteConfigPath).href },
  })
  await ctx.loader.await()
  assertEntriesLoaded(ctx, binName)
  return ctx
}
