#!/usr/bin/env node
/**
 * Boot a TUI app from a leaf `cordis.yml`; usage is `dsh-tui-demo [config]`, defaulting to the
 * cwd file. Shared `.env` loading, fail-loud Loader guards, and settled-tree boot live in
 * dsh-app-boot. The tui-agent and cordis-agent demos invoke this bin with their own leaf configs.
 * @module @deepseek-ai/dsh-tui-demo/bin
 */

import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'dsh-tui-demo'

/* v8 ignore start -- thin self-executing composition over the unit-tested
   dsh-app-boot helpers; exercised end-to-end by the keyless Loader-path and
   built-bin smokes */
installFailLoud(NAME)
loadEnv(NAME)
await boot(NAME, resolveConfigPath(process.argv[2] ?? './cordis.yml', undefined))
/* v8 ignore stop */
