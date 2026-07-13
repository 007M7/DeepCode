#!/usr/bin/env node
/**
 * Boot an ACP stdio server from `cordis.yml`; usage is `dsh-acp-agent [config]`, defaulting to the
 * cwd file. Shared env loading, Loader guards, snapshot config selection, and settled-tree boot live
 * in dsh-app-boot. Replay skips `.env` and selects sibling `cordis.snapshot.yml` so a stray key
 * cannot trigger a model call. EOF disposes and flushes snapshot runs; editors normally own process
 * lifetime. Stdout is reserved for JSON-RPC—write diagnostics only to stderr.
 * @module @deepseek-ai/dsh-acp-agent/bin
 */

import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'dsh-acp-agent'

/* v8 ignore start -- thin self-executing composition over the unit-tested
   dsh-app-boot helpers; exercised end-to-end by the snapshot suite and the
   built-bin smoke */
installFailLoud(NAME)
const snapshotMode = process.env['DSH_SNAPSHOT']
if (snapshotMode !== 'replay') loadEnv(NAME)
const ctx = await boot(NAME, resolveConfigPath(process.argv[2] ?? './cordis.yml', snapshotMode))
if (snapshotMode !== undefined) {
  process.stdin.on('end', () => {
    void ctx.fiber.dispose().then(() => { process.exit(0) })
  })
}
/* v8 ignore stop */
