#!/usr/bin/env node
/**
 * dsh — command-line entry. Parses argv once through the Commander adapter and
 * switches on the resolved mode; dynamic imports keep unrelated modes out of
 * each dispatch path. `web` and headless prompts run their own module;
 * everything else opens the TUI. `--help`/`--version` print and exit 0; a parse
 * error prints to stderr and exits 1.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin and PTY tests exercise this self-executing dispatch. */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadEnv } from '@deepseek-ai/dsh-app-boot'
import { parseDshArgs } from './args.ts'

// Both the source tree (apps/cli/src) and the bundled bin (apps/cli/lib) sit
// one directory under apps/cli, so the checked-in manifest resolves with the
// same relative hop from either artifact.
/** This app's version, read from its checked-in package.json. */
function readVersion(): string {
  const manifest = JSON.parse(
    readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8'),
  ) as { version?: unknown }
  return typeof manifest.version === 'string' ? manifest.version : '0.0.0'
}

loadEnv('dsh')
const invocation = parseDshArgs(process.argv.slice(2), readVersion())

switch (invocation.mode) {
  case 'web': {
    const { runWeb } = await import('./web.ts')
    await runWeb(invocation.host, invocation.port, invocation.dev)
    break
  }
  case 'headless': {
    const { runHeadless } = await import('./headless.ts')
    await runHeadless(invocation.prompt)
    break
  }
  case 'tui': {
    const { runTui } = await import('./tui.ts')
    await runTui(invocation.config, invocation.resume)
    break
  }
  case 'help':
  case 'version':
    process.stdout.write(invocation.text)
    process.exit(0)
  case 'error':
    process.stderr.write(`${invocation.message}\n`)
    process.exit(1)
  default:
    invocation satisfies never
    throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
}
