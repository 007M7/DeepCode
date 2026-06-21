#!/usr/bin/env node
/**
 * The `dsh-acp-agent` bin: boot the ACP server from a leaf `cordis.yml` that
 * loads the {@link @deepseek-ai/dsh-acp-agent} app plugin (plus an LLM adapter
 * and a bash executor), speaking ACP JSON-RPC on stdio.
 *
 * Owns the ACP-specific boot glue the example's `start.ts` once held:
 *  - `.env` loading (`DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL`) — SKIPPED in
 *    snapshot REPLAY so a stray key can never trigger a live model call.
 *  - snapshot-mode config selection: `DSH_SNAPSHOT=replay` swaps the given
 *    `cordis.yml` for its sibling `cordis.snapshot.yml` (the keyless replay
 *    tree: `llm-replay` in place of `llm-deepseek`).
 *  - the stdin-dispose lifecycle: in a snapshot run the harness closes stdin
 *    when done, so dispose the context (flushing persistence) and exit cleanly.
 *
 * IMPORTANT: stdout is the ACP JSON-RPC channel. This bin writes diagnostics to
 * STDERR only; the app plugin loads no stdout logger. A stray stdout write
 * corrupts the protocol frames.
 *
 * Usage: `dsh-acp-agent [path-to-cordis.yml]` (default `./cordis.yml`).
 *
 * @module @deepseek-ai/dsh-acp-agent/bin
 */

import { pathToFileURL } from 'node:url'
import { basename, dirname, resolve } from 'node:path'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

/**
 * Resolve the config to boot, honoring snapshot REPLAY. Given the requested
 * path, replay mode swaps a `cordis.yml` basename for `cordis.snapshot.yml` in
 * the SAME directory (the keyless replay tree). Other modes use the path as-is.
 * Returns an absolute path resolved from the cwd.
 */
export function resolveConfigPath(configPath: string, snapshotMode: string | undefined): string {
  const absolute = resolve(process.cwd(), configPath)
  if (snapshotMode !== 'replay') return absolute
  const dir = dirname(absolute)
  const replayName = basename(absolute).replace(/cordis\.ya?ml$/, 'cordis.snapshot.yml')
  return resolve(dir, replayName)
}

/**
 * Load `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` from a gitignored `.env` in the
 * cwd (Node native). Diagnostics go to STDERR (stdout is the protocol). In
 * REPLAY mode the caller skips this entirely — replay must never reach the
 * network, so a present `.env` must not enable a live call.
 */
function loadEnv(): void {
  try {
    process.loadEnvFile(resolve(process.cwd(), '.env'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      process.stderr.write(`dsh-acp-agent: failed to load .env: ${String(error)}\n`)
    }
    // ENOENT (no .env) is fine — rely on the ambient environment.
  }
}

/**
 * Make a load failure fail loud with a clear message on stderr. Covers the
 * failure path the entry-tree check below cannot: when the include's
 * `[Service.init]` throws (e.g. a config FILE missing in a real directory), the
 * cordis Loader surfaces it as an unhandled promise rejection AFTER `boot()`
 * resolves — `loader.await()` does NOT rethrow it (`EntryTree.await()` uses
 * `Promise.allSettled`, which swallows rejections). Node's default handler
 * already exits non-zero on an unhandled rejection, so this does not change the
 * exit code; it replaces the noisy stack dump with a single labelled line (on
 * STDERR — stdout is the ACP JSON-RPC channel) and guarantees `process.exit(1)`.
 * Install before `boot()`.
 */
export function installFailLoud(): void {
  process.on('unhandledRejection', (err: unknown) => {
    process.stderr.write(`dsh-acp-agent: fatal load failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exit(1)
  })
}

/**
 * After the tree settles, assert every loader entry actually started. This is
 * the load-bearing guard against the SILENT-exit-0 bug: a plugin module that
 * fails to IMPORT (e.g. a config path in a non-existent directory) is caught and
 * only LOGGED by the cordis Loader (`entry._init`), leaving the entry with no
 * `fiber` and producing no rejection — so the process would otherwise exit 0. A
 * started entry has a `fiber`; throw on any entry still missing one so `boot()`
 * rejects.
 *
 * A `disabled` entry is the one legitimate fiber-less state: `Entry.refresh()`
 * deliberately skips `init()` for it, so it settles without a fiber by design —
 * a valid "plugin turned off" config, not a failed import. Exclude it.
 */
function assertEntriesLoaded(ctx: Context): void {
  const failed = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
  if (failed.length > 0) {
    const names = failed.map(entry => entry.options.name).join(', ')
    throw new Error(`dsh-acp-agent: plugin(s) failed to load: ${names} (see the error(s) logged above)`)
  }
}

/**
 * Boot the Loader against `absoluteConfigPath`. The include is handed the
 * config's ABSOLUTE `file://` URL as its `path`, so resolution never depends on
 * `ctx.baseUrl` (an absolute URL ignores the base) and can never fall back to
 * the cwd. `baseUrl` is still pinned to the config's directory so the config's
 * OWN relative plugin/include paths resolve against it. Returns the root context
 * once the whole tree has settled.
 *
 * The `await ctx.loader.await()` is load-bearing: `loader.create()` returns once
 * the include ENTRY is registered, but the include then loads its child plugins
 * asynchronously. Without awaiting the tree, `boot()` would resolve while the ACP
 * bridge is still mounting — the process would have no stdin handle attached yet
 * and could exit 0 silently. Awaiting keeps the process alive until the bridge
 * is up.
 *
 * `loader.await()` does NOT rethrow load errors (`EntryTree.await()` uses
 * `Promise.allSettled`), so failures are surfaced two ways: a plugin that fails
 * to IMPORT leaves an entry with no fiber, caught here by
 * {@link assertEntriesLoaded} (this `boot()` rejects); a plugin whose init THROWS
 * surfaces as an unhandled rejection caught by {@link installFailLoud} (installed
 * by `main()` before this runs). Together any load failure exits non-zero.
 *
 * Bare plugin specifiers in the config (`@deepseek-ai/dsh-*`, npm packages) are
 * resolved by the cordis Loader's internal module loader, which is only active
 * under `node --expose-internals`. The `demo:acp` script runs under tsx (whose
 * tsconfig `paths` map resolves the workspace plugins instead), but a consumer
 * running the built bin under plain node must pass `--expose-internals` so the
 * Loader resolves the config's plugins from the config directory rather than
 * relative to its own module.
 */
export async function boot(absoluteConfigPath: string): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
  await ctx.plugin(Loader)
  await ctx.loader.create({
    name: '@cordisjs/plugin-include',
    config: { path: pathToFileURL(absoluteConfigPath).href },
  })
  await ctx.loader.await()
  assertEntriesLoaded(ctx)
  return ctx
}

/**
 * Entry point. Installs the fail-loud guard, selects the config (snapshot-aware),
 * loads `.env` outside replay, boots, and — in a snapshot run — disposes the
 * context on stdin EOF so the session log is fully flushed before exit and the
 * harness's `waitForExit` resolves. In a normal editor session stdin stays open
 * for the connection's lifetime (the editor kills the process), so the EOF
 * handler never fires.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  installFailLoud()
  const snapshotMode = process.env.DSH_SNAPSHOT
  const configPath = resolveConfigPath(argv[0] ?? './cordis.yml', snapshotMode)
  if (snapshotMode !== 'replay') loadEnv()
  const ctx = await boot(configPath)
  if (snapshotMode !== undefined) {
    process.stdin.on('end', () => {
      void ctx.fiber.dispose().then(() => { process.exit(0) })
    })
  }
}

/* v8 ignore start -- top-level CLI invocation; the testable core is
   resolveConfigPath()/boot()/main(), driven by the keyless snapshot + Loader-path tests */
await main()
/* v8 ignore stop */
