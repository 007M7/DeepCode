import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

// Bundle JS for every workspace package with dumble (tsc -b has already
// produced the .d.ts files; dumble reads each package's tsconfig/package.json).
const packages = [
  'vendor/cosmokit',
  'vendor/schemastery',
  'vendor/cordis',
  'vendor/loader',
  'vendor/include',
  'vendor/group',
  'vendor/timer',
  'vendor/hmr',
  'vendor/logger-console',
  'packages/llm',
  'packages/session',
  'packages/system-prompt',
  'packages/tools',
  'packages/agent',
  'packages/agent-loop',
]

const root = resolve(import.meta.dirname, '..')
for (const path of packages) {
  if (!existsSync(resolve(root, path, 'tsconfig.json'))) continue
  execFileSync('node_modules/.bin/dumble', [path], { cwd: root, stdio: 'inherit' })
}
