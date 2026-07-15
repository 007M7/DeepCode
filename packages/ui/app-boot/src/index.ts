/**
 * Shared boot glue for the app bins (`dsh-stdio-agent`, `dsh-acp-agent`): load the gitignored
 * `.env`, install the fail-loud Loader guards, resolve the config path (snapshot-aware), and
 * drive the cordis Loader against a leaf `cordis.yml` until the whole tree has settled.
 * @module @deepseek-ai/dsh-app-boot
 */

import { pathToFileURL } from 'node:url'
import { basename, dirname, resolve } from 'node:path'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'

/**
 * Resolve the config to boot. Replay swaps a `cordis.yml` basename for
 * `cordis.snapshot.yml` in the same directory; every other mode keeps the path.
 * @param configPath - the requested config path (absolute, or relative to `cwd`).
 * @param snapshotMode - the bin's `$DSH_SNAPSHOT` value; only `'replay'` swaps the
 *   basename.
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
 * Load the optional gitignored `.env` from `dir`. Missing files fall back to the
 * ambient environment; other read failures are reported through `warn`.
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
 * Install before boot to turn a late unhandled plugin-init rejection into one
 * labelled stderr diagnostic and `exit(1)`. Stdout remains untouched for ACP;
 * the returned function removes the handler.
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
 * After the tree settles, reject entries with no fiber, which indicates a
 * swallowed module-import failure. Disabled entries are the only valid
 * fiber-less state.
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
 * Boot the Loader against `absoluteConfigPath` and return only after the whole
 * tree settles. Entry names load through the Loader's internal module loader
 * against `baseUrl` (the config directory), which may live outside
 * `node_modules` reach and, unbuilt, cannot load vendored source; the
 * bootstrap include is therefore statically imported and mounted as the
 * `cordis:include` builtin, loading through the ambient module pipeline
 * (vite/tsx/plain ESM) while the included tree's own specifiers stay
 * config-relative. A missing fiber rejects here; a later init rejection is
 * handled by {@link installFailLoud}. Built bins need `--expose-internals` or
 * the Loader's native fallback for bare plugin specifiers; relative specifiers
 * do not.
 * @param binName - the diagnostic prefix for load-failure errors.
 * @param absoluteConfigPath - the config to include; must already be absolute
 * (see {@link resolveConfigPath}).
 * @returns the root context once every entry has started.
 */
export async function boot(binName: string, absoluteConfigPath: string): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(absoluteConfigPath).href },
  })
  await ctx.loader.await()
  assertEntriesLoaded(ctx, binName)
  return ctx
}
