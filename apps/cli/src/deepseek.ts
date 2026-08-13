#!/usr/bin/env node
/**
 * `deepseek` — direct local terminal Agent entry. This is a product alias for
 * the shipped `cli` profile, not a second implementation of the CLI.
 * @module @deepseek-ai/dsh/deepseek
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { parseDshArgs } from './args.ts'
import { readVersion, runInvocation } from './launcher.ts'

const argv = process.argv.slice(2)
const version = readVersion()

if (argv.length === 1 && (argv[0] === '--version' || argv[0] === '-V')) {
  process.stdout.write(`${version}\n`)
} else {
  await runInvocation(parseDshArgs(['cli', ...argv], version))
}
