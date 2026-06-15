import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

// publint every publishable package (vendor/ is private upstream code and
// examples/ are not packages; both are out of scope).
const packages = [
  'packages/llm',
  'packages/session',
  'packages/session-persistence',
  'packages/session-persistence-jsonl',
  'packages/session-persistence-sqlite',
  'packages/system-prompt',
  'packages/tools',
  'packages/agent',
  'packages/agent-loop',
  'packages/bash',
  'packages/llm-deepseek',
  'packages/llm-pi-ai',
  'packages/bash-local',
  'packages/tool-bash',
  'packages/invariants',
]

const root = resolve(import.meta.dirname, '..')
for (const path of packages) {
  execFileSync('node_modules/.bin/publint', [path], { cwd: root, stdio: 'inherit' })
}
