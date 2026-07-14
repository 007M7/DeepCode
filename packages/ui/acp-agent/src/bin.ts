#!/usr/bin/env node
/**
 * The `dsh-acp-agent` bin: boot the ACP server from a leaf `cordis.yml` that
 * loads the {@link @deepseek-ai/dsh-acp-agent} app plugin (plus an LLM adapter
 * and a bash executor), speaking ACP JSON-RPC on stdio. The shared boot glue —
 * `.env` loading, the fail-loud Loader guards, snapshot-aware config
 * resolution, the settle-the-tree boot sequence — lives in
 * {@link @deepseek-ai/dsh-app-boot}; this bin owns only the ACP-specific
 * lifecycle:
 *
 *  - `.env` loading is SKIPPED in snapshot REPLAY so a stray key can never
 *    trigger a live model call.
 *  - `DSH_SNAPSHOT=replay` swaps the given `cordis.yml` for its sibling
 *    `cordis.snapshot.yml` (the keyless replay tree: `llm-replay` in place of
 *    `llm-deepseek`).
 *  - In a snapshot run the harness closes stdin when done, so dispose the
 *    context (flushing persistence) and exit cleanly. In a normal editor
 *    session stdin stays open for the connection's lifetime (the editor kills
 *    the process), so the EOF handler never fires.
 *
 * IMPORTANT: stdout is the ACP JSON-RPC channel. This bin writes diagnostics to
 * STDERR only (the app plugin loads no stdout logger, and the shared guards
 * write to stderr); a stray stdout write corrupts the protocol frames.
 *
 * Usage: `dsh-acp-agent [--config path-to-cordis.yml]` (default
 * `./cordis.yml`).
 *
 * @module @deepseek-ai/dsh-acp-agent/bin
 */

import { parseArgs } from 'node:util'
import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'dsh-acp-agent'

/* v8 ignore start -- thin self-executing composition over the unit-tested
   dsh-app-boot helpers; exercised end-to-end by the snapshot suite and the
   built-bin smoke */
installFailLoud(NAME)
const snapshotMode = process.env['DSH_SNAPSHOT']
if (snapshotMode !== 'replay') loadEnv(NAME)
const { values } = parseArgs({
  args: process.argv.slice(2),
  options: { config: { type: 'string', short: 'c' } },
  strict: true,
})
const ctx = await boot(NAME, resolveConfigPath(values.config ?? './cordis.yml', snapshotMode))
if (snapshotMode !== undefined) {
  process.stdin.on('end', () => {
    void ctx.fiber.dispose().then(() => { process.exit(0) })
  })
}
/* v8 ignore stop */
