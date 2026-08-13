#!/usr/bin/env node
/**
 * dsh — command-line entry. Dynamic imports per mode keep unrelated modes out
 * of each dispatch path; the adapter prints and exits for
 * `--help`/`--version`/a parse error, so only a valid mode reaches the switch.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { parseDshArgs } from './args.ts'
import { readVersion, runInvocation } from './launcher.ts'

await runInvocation(parseDshArgs(process.argv.slice(2), readVersion()))
