#!/usr/bin/env node
/**
 * The `dsh-jsonrpc-agent` bin: boot a harness from an externally supplied
 * `cordis.yml` whose `@deepseek-ai/dsh-jsonrpc` entry serves SDK clients over
 * newline-delimited JSON-RPC on stdio. The shared boot glue — `.env` loading,
 * the fail-loud Loader guards, the settle-the-tree boot sequence — lives in
 * {@link @deepseek-ai/dsh-app-boot}, shared with the stdio/ACP bins; this bin
 * owns only config discovery and the process-level exit lifecycle:
 *
 *  - Config discovery is `$DSH_CORDIS_CONFIG` (the existing SDK-client
 *    convention, wins) or the `argv[2]` positional path (the human channel,
 *    isomorphic to `dsh-acp-agent`); an empty value counts as absent. Neither
 *    given, or the path missing on disk, prints the one-line usage to stderr
 *    and exits 1. No built-in fallback — the external config IS the deployment
 *    (docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md).
 *    No `DSH_SNAPSHOT` handling: this
 *    protocol is not part of the ACP snapshot tier.
 *  - stdin EOF (the SDK client is gone) and SIGTERM dispose the root context
 *    to quiescence and exit 0; SIGINT does the same but exits 130. The
 *    `shutdown` JSON-RPC request's answer-then-exit-0 path is owned by the
 *    `dsh-jsonrpc` plugin, which holds the server (see its README).
 *
 * IMPORTANT: stdout is the JSON-RPC channel. Diagnostics go to STDERR only (a
 * stray stdout write corrupts the protocol frames), which the app-boot guards
 * already honor.
 *
 * @module @deepseek-ai/dsh-jsonrpc-agent/bin
 */

import { existsSync } from 'node:fs'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'dsh-jsonrpc-agent'

/* v8 ignore start -- thin self-executing composition over the unit-tested
   dsh-app-boot helpers; the serving lifecycle it boots is unit-tested in
   @deepseek-ai/dsh-jsonrpc, and the composed artifact is exercised by the
   single-exe acceptance drive (docs/rfc/implemented/architecture/2026-07-10-single-file-executable-sdk-runtime-distribution.md) */
installFailLoud(NAME)
loadEnv(NAME)

// Env wins over the positional argument; an empty value on either channel
// counts as absent. There is deliberately NO default `./cordis.yml`: "the
// plugins that actually start come from an explicit external config" is a
// hard semantic of the SDK runtime.
const fromEnv = process.env['DSH_CORDIS_CONFIG']
const fromArgv = process.argv[2]
const requested = fromEnv !== undefined && fromEnv !== ''
  ? fromEnv
  : fromArgv !== undefined && fromArgv !== '' ? fromArgv : undefined
const configPath = requested === undefined ? undefined : resolveConfigPath(requested, undefined)
if (configPath === undefined || !existsSync(configPath)) {
  process.stderr.write(
    `usage: ${NAME} <path/to/cordis.yml> (or set DSH_CORDIS_CONFIG=<path>, which wins); the config is required — there is no built-in fallback\n`,
  )
  process.exit(1)
}

const ctx = await boot(NAME, configPath)
let exiting = false

async function disposeAndExit(code: number): Promise<void> {
  if (exiting) return
  exiting = true
  try {
    await ctx.fiber.dispose()
  } finally {
    process.exit(code)
  }
}

process.stdin.on('end', () => { void disposeAndExit(0) })
process.on('SIGTERM', () => { void disposeAndExit(0) })
process.on('SIGINT', () => { void disposeAndExit(130) })
/* v8 ignore stop */
