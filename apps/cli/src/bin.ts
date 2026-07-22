#!/usr/bin/env node
/**
 * dsh — command-line entry. Coarse dispatch only; each subcommand module owns
 * its parseArgs. Dynamic imports keep the shapes independent: `web` never
 * loads the headless consumer, `-p` never loads node:http or the static server.
 */

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
  process.stderr.write('usage: dsh web [--port N] | dsh -p "task"\n')
  process.exit(1)
}
