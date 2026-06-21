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
 * Boot the Loader against `absoluteConfigPath`. `baseUrl` is pinned to the
 * config's directory and the include gets only the basename, so the config's
 * relative plugin/include paths resolve as the upstream `cordis` bin does.
 * Returns the root context.
 */
export async function boot(absoluteConfigPath: string): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + '/'
  await ctx.plugin(Loader)
  await ctx.loader.create({
    name: '@cordisjs/plugin-include',
    config: { path: `./${basename(absoluteConfigPath)}` },
  })
  return ctx
}

/**
 * Entry point. Selects the config (snapshot-aware), loads `.env` outside replay,
 * boots, and — in a snapshot run — disposes the context on stdin EOF so the
 * session log is fully flushed before exit and the harness's `waitForExit`
 * resolves. In a normal editor session stdin stays open for the connection's
 * lifetime (the editor kills the process), so the EOF handler never fires.
 */
export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
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
