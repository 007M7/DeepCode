#!/usr/bin/env node
/**
 * The `dsh-stdio-agent` bin: boot a Cordis app from a leaf `cordis.yml` that
 * loads the {@link @deepseek-ai/dsh-stdio-agent} app plugin (plus a backend LLM
 * adapter and a bash executor). Owns the boot glue the three `examples/*` once
 * duplicated in their `start.ts`: load the gitignored repo-root `.env`, then
 * drive the cordis Loader against the config path (default `./cordis.yml`).
 *
 * Usage: `dsh-stdio-agent [path-to-cordis.yml]`. The `demo:echo` / `demo:repl`
 * scripts invoke it with the example's config.
 *
 * @module @deepseek-ai/dsh-stdio-agent/bin
 */

import { pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'

/**
 * Load `DEEPSEEK_API_KEY` / `DEEPSEEK_BASE_URL` from a gitignored `.env` in the
 * CURRENT WORKING DIRECTORY (Node native `process.loadEnvFile`). An absent file
 * is fine — the environment may already carry the variables; the leaf
 * `cordis.yml` reads them via the `!!js` tag. A present-but-unreadable/malformed
 * `.env` is a real misconfiguration: surface it on stderr rather than silently
 * running with the wrong environment. The mock-model demo (echo) ships no key
 * and simply has no `.env`.
 */
function loadEnv(): void {
  try {
    process.loadEnvFile(resolve(process.cwd(), '.env'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== 'ENOENT') {
      process.stderr.write(`dsh-stdio-agent: failed to load .env: ${String(error)}\n`)
    }
    // ENOENT (no .env) is fine — rely on the ambient environment.
  }
}

/**
 * Make a load failure fail loud with a clear message on stderr. Covers the
 * failure path the entry-tree check below cannot: when the include's
 * `[Service.init]` throws (e.g. a config FILE that does not exist in a real
 * directory), the cordis Loader surfaces it as an unhandled promise rejection
 * AFTER `boot()` has resolved — `loader.await()` does NOT rethrow it, because
 * `EntryTree.await()` uses `Promise.allSettled`, which swallows rejections.
 * Node's default handler already exits non-zero on an unhandled rejection, so
 * this does not change the exit code; it replaces Node's noisy stack dump with a
 * single labelled line and guarantees `process.exit(1)`. Install before `boot()`.
 */
export function installFailLoud(): void {
  process.on('unhandledRejection', (err: unknown) => {
    process.stderr.write(`dsh-stdio-agent: fatal load failure: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`)
    process.exit(1)
  })
}

/**
 * After the tree settles, assert every loader entry actually started. This is
 * the load-bearing guard against the SILENT-exit-0 bug: when a plugin module
 * fails to IMPORT (e.g. a config path in a non-existent directory, so the include
 * plugin itself cannot be resolved), the cordis Loader catches the import error
 * and only LOGS it (`entry._init`), leaving the entry with no `fiber` and
 * producing no rejection — so the process would otherwise exit 0 with a usable
 * config typo reported only as a log line. A started entry has a `fiber`; an
 * entry with `fiber === undefined` after the tree settled never loaded. Throw on
 * any such entry so `boot()` rejects (and the top-level `await` fails the process
 * non-zero) instead of returning a half-empty context.
 *
 * A `disabled` entry is the one legitimate fiber-less state: `Entry.refresh()`
 * deliberately skips `init()` for it, so it settles without a fiber by design.
 * That is a valid config (a consumer turning an optional plugin off), not a
 * failed import — exclude it so the guard catches only real load failures.
 */
function assertEntriesLoaded(ctx: Context): void {
  const failed = [...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)
  if (failed.length > 0) {
    const names = failed.map(entry => entry.options.name).join(', ')
    throw new Error(`dsh-stdio-agent: plugin(s) failed to load: ${names} (see the error(s) logged above)`)
  }
}

/**
 * Boot the Loader against `configPath` (resolved from the CWD). The include is
 * handed the config's ABSOLUTE `file://` URL as its `path`, so resolution never
 * depends on `ctx.baseUrl` (an absolute URL ignores the base) and can never fall
 * back to the cwd. `baseUrl` is still pinned to the config's directory so the
 * config's OWN relative plugin/include paths (e.g. `./src/mock-llm.ts`) resolve
 * against it. Returns the root context once the whole tree has settled.
 *
 * The `await ctx.loader.await()` is load-bearing: `loader.create()` returns once
 * the include ENTRY is registered, but the include then loads its child plugins
 * asynchronously. Without awaiting the tree, `boot()` (and `main()`) would
 * resolve while the app plugins — the stdin reader, the agent loop — are still
 * mounting, and a CLI process with no attached handles yet exits 0 silently.
 * Awaiting the tree keeps the process alive until the app's handles are attached.
 *
 * `loader.await()` does NOT, however, rethrow load errors (`EntryTree.await()`
 * uses `Promise.allSettled`), so failures are surfaced two ways: a plugin that
 * fails to IMPORT leaves an entry with no fiber, caught here by
 * {@link assertEntriesLoaded} (this `boot()` rejects); a plugin whose init
 * THROWS surfaces as an unhandled rejection caught by {@link installFailLoud}
 * (installed by `main()` before this runs). Together they make any load failure
 * exit non-zero with a clear message.
 *
 * Bare plugin specifiers in the config (`@deepseek-ai/dsh-*`, npm packages) are
 * resolved by the cordis Loader's internal module loader, which is only active
 * under `node --expose-internals` (the flag the `demo:echo`/`demo:repl` scripts
 * pass). Without it the Loader falls back to resolving relative to its own module
 * and cannot find the config's plugins, so a consumer running the built bin must
 * pass `--expose-internals` (or install the plugins where node hoists them).
 */
export async function boot(configPath: string): Promise<Context> {
  const absolute = resolve(process.cwd(), configPath)
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dirname(absolute)).href + '/'
  await ctx.plugin(Loader)
  await ctx.loader.create({
    name: '@cordisjs/plugin-include',
    config: { path: pathToFileURL(absolute).href },
  })
  await ctx.loader.await()
  assertEntriesLoaded(ctx)
  return ctx
}

/**
 * Entry point: install the fail-loud guard, load `.env`, then boot the config
 * named on argv (default `./cordis.yml`). Awaited at the module top level by the
 * published bin (`#!/usr/bin/env node` shebang via the package's `bin` field).
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  installFailLoud()
  loadEnv()
  await boot(argv[0] ?? './cordis.yml')
}

/* v8 ignore start -- top-level CLI invocation; the testable core is boot()/main(), driven by the keyless Loader-path smoke */
await main()
/* v8 ignore stop */
