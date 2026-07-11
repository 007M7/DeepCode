#!/usr/bin/env node
/**
 * The `dsh-acp-agent` bin: boot the ACP server from a leaf `cordis.yml` that loads the {@link
 * @deepseek-ai/dsh-acp-agent} app plugin (plus an LLM adapter and a bash executor), speaking
 * ACP JSON-RPC on stdio.
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
