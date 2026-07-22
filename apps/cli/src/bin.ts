#!/usr/bin/env node
/**
 * dsh — command-line entry. Coarse dispatch only; each surface module owns its
 * own argument handling. `web` and `-p`/`--prompt` are reserved for the
 * browser GUI and headless surfaces (PR #443) so that dispatch merges as a
 * union; everything else is the interactive TUI, the default surface.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- thin self-executing dispatch; the tui-agent PTY smoke
   exercises the TUI path end to end */

import { loadEnv } from '@deepseek-ai/dsh-app-boot'
import { runTui } from './tui.ts'

loadEnv('dsh')
const argv = process.argv.slice(2)

if (argv[0] === 'web' || argv.includes('-p') || argv.includes('--prompt')) {
  process.stderr.write('dsh: the web and headless surfaces are not on this branch (PR #443); run the TUI: dsh [config.yml]\n')
  process.exit(1)
}
await runTui(argv)
