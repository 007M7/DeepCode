#!/usr/bin/env node
/**
 * Boot a stdio app from a leaf `cordis.yml`; usage is `dsh-stdio-agent [config]`, defaulting to the
 * cwd file. Shared `.env` loading, fail-loud Loader guards, and settled-tree boot live in
 * dsh-app-boot. The echo and REPL demos invoke this bin with their own leaf configs.
 * @module @deepseek-ai/dsh-stdio-agent/bin
 */

import { boot, installFailLoud, loadEnv, resolveConfigPath } from '@deepseek-ai/dsh-app-boot'

const NAME = 'dsh-stdio-agent'

/* v8 ignore start -- thin self-executing composition over the unit-tested
   dsh-app-boot helpers; exercised end-to-end by the keyless Loader-path and
   built-bin smokes */
installFailLoud(NAME)
loadEnv(NAME)
await boot(NAME, resolveConfigPath(process.argv[2] ?? './cordis.yml', undefined))
/* v8 ignore stop */
