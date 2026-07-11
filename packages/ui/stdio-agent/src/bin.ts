#!/usr/bin/env node
/**
 * The `dsh-stdio-agent` bin: boot a Cordis app from a leaf `cordis.yml` that loads the {@link
 * @deepseek-ai/dsh-stdio-agent} app plugin (plus a backend LLM adapter and a bash executor).
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
