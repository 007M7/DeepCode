/**
 * Boot the Code Mode demo under the UI named on the command line:
 * `pnpm run demo:code-mode [repl|acp]`, default `repl`. Code Mode is the
 * point — the UI is just the surface it happens to wear: each UI boots its
 * base example through that example's `code-mode.cordis.yml` overlay
 * (include ./cordis.yml, flip `tools.mode` to `code`, insert the
 * worker-thread code runtime). Both need DEEPSEEK_API_KEY (repo-root .env
 * works). Anything else on the command line is a misconfiguration and
 * fails loud with usage.
 */
import { spawn } from 'node:child_process'

// Each UI's node invocation, verbatim what its base demo script runs plus
// the overlay config (the stdio bin keeps --expose-internals for the cordis
// Loader's HMR path).
const UIS = new Map([
  ['repl', ['--expose-internals', '--import', 'tsx', 'packages/ui/stdio-agent/src/bin.ts', 'examples/coding-agent/code-mode.cordis.yml']],
  ['acp', ['--import', 'tsx', 'packages/ui/acp-agent/src/bin.ts', '--config', 'examples/acp-agent/code-mode.cordis.yml']],
])

const ui = process.argv[2] ?? 'repl'
const args = UIS.get(ui)
if (!args || process.argv.length > 3) {
  console.error('usage: pnpm run demo:code-mode [repl|acp]')
  process.exit(2)
}

const child = spawn(process.execPath, args, { stdio: 'inherit' })
child.on('exit', (code, signal) => { process.exit(signal !== null ? 1 : code ?? 1) })
