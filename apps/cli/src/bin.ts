#!/usr/bin/env node
/**
 * dsh — command-line entry. Coarse dispatch only; each surface module owns its
 * argument handling. Dynamic imports keep unrelated surfaces out of each
 * dispatch path; everything except `web` and headless prompts opens the TUI.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin and PTY tests exercise this self-executing dispatch. */

import { loadEnv } from '@deepseek-ai/dsh-app-boot'

loadEnv('dsh')
const argv = process.argv.slice(2)

if (argv[0] === 'web') {
  const { runWeb } = await import('./web.ts')
  await runWeb(argv.slice(1))
} else if (argv.includes('-p') || argv.includes('--prompt')) {
  const { runHeadless } = await import('./headless.ts')
  await runHeadless(argv)
} else {
  const { runTui } = await import('./tui.ts')
  await runTui(argv)
}
