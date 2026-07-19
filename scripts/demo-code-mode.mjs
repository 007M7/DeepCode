/**
 * Boot the REPL, TUI, or ACP Code Mode overlay, defaulting to REPL. Each overlay
 * includes its base example, selects Code Mode, and adds the worker runtime.
 * All require a DeepSeek API key; unsupported arguments fail with usage.
 */
import { spawn } from 'node:child_process'

// Each UI's node invocation, verbatim what its base demo script runs plus
// the overlay config (the stdio bin keeps --expose-internals for the cordis
// Loader's HMR path).
const UIS = new Map([
  ['repl', ['--expose-internals', '--import', 'tsx', 'packages/examples/stdio-demo/src/bin.ts', 'examples/repl-agent/code-mode.cordis.yml']],
  ['tui', ['--expose-internals', '--import', 'tsx', 'packages/examples/stdio-demo/src/bin.ts', 'examples/tui-agent/code-mode.cordis.yml']],
  ['acp', ['--import', 'tsx', 'packages/examples/acp-demo/src/bin.ts', '--config', 'examples/acp-agent/code-mode.cordis.yml']],
])

const ui = process.argv[2] ?? 'repl'
const args = UIS.get(ui)
if (!args || process.argv.length > 3) {
  console.error('usage: pnpm run demo:code-mode [repl|tui|acp]')
  process.exit(2)
}

const child = spawn(process.execPath, args, { stdio: 'inherit' })
child.on('exit', (code, signal) => { process.exit(signal !== null ? 1 : code ?? 1) })
