/**
 * Boot the TUI or ACP Code Mode overlay, defaulting to TUI. Each overlay
 * includes its base example, selects Code Mode, and adds the worker runtime.
 * All require a DeepSeek API key; unsupported arguments fail with usage.
 */
import { spawn } from 'node:child_process'

// Each UI's node invocation matches its base demo script plus the overlay config.
const UIS = new Map([
  ['tui', [
    '--import',
    'tsx/esm',
    'apps/cli/src/bin.ts',
    '--config',
    'examples/tui-agent/code-mode.cordis.yml',
  ]],
  ['acp', ['--import', 'tsx', 'packages/examples/acp-demo/src/bin.ts', '--config', 'examples/acp-agent/code-mode.cordis.yml']],
])

const ui = process.argv[2] ?? 'tui'
const args = UIS.get(ui)
if (!args || process.argv.length > 3) {
  console.error('usage: pnpm run demo:code-mode [tui|acp]')
  process.exit(2)
}

const child = spawn(process.execPath, args, { stdio: 'inherit' })
child.on('exit', (code, signal) => { process.exit(signal !== null ? 1 : code ?? 1) })
