#!/usr/bin/env node
/**
 * The `dsh-stdio-agent` bin: boot a Cordis app from a leaf `cordis.yml` that
 * loads the {@link @deepseek-ai/dsh-stdio-agent} app plugin (plus a backend LLM
 * adapter and a bash executor). Owns the boot glue the three `examples/*` once
 * duplicated in their `start.ts`: load the gitignored repo-root `.env`, then
 * drive the cordis Loader against the config path (default `./cordis.yml`).
 *
 * Usage: `dsh-stdio-agent [path-to-cordis.yml]`. The `demo:echo` / `demo:coding`
 * scripts invoke it with the example's config.
 *
 * @module @deepseek-ai/dsh-stdio-agent/bin
 */

import { pathToFileURL } from 'node:url'
import { basename, dirname, resolve } from 'node:path'
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
 * Boot the Loader against `configPath` (resolved from the CWD). `baseUrl` is
 * pinned to the config's directory and the include is handed only the basename,
 * so the config's relative plugin/include paths resolve exactly as the upstream
 * `cordis` bin does. Returns the root context (the process owns its lifetime).
 */
export async function boot(configPath: string): Promise<Context> {
  const absolute = resolve(process.cwd(), configPath)
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dirname(absolute)).href + '/'
  await ctx.plugin(Loader)
  await ctx.loader.create({
    name: '@cordisjs/plugin-include',
    config: { path: `./${basename(absolute)}` },
  })
  return ctx
}

/**
 * Entry point: load `.env`, then boot the config named on argv (default
 * `./cordis.yml`). Awaited at the module top level by the published bin
 * (`#!/usr/bin/env node` shebang via the package's `bin` field).
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  loadEnv()
  await boot(argv[0] ?? './cordis.yml')
}

/* v8 ignore start -- top-level CLI invocation; the testable core is boot()/main(), driven by the keyless Loader-path smoke */
await main()
/* v8 ignore stop */
