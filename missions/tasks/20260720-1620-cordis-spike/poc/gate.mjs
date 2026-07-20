#!/usr/bin/env node
/**
 * Gate prototype: verify a browser TS program's transitive closure is clean.
 *
 * Two independent checks over the EXACT program file set (tsc --listFilesOnly,
 * so it sees type-only edges the bundler would erase):
 *   A. closure hygiene — no file matches a node-half pattern
 *      (src/node.ts entries, node-only package dirs);
 *   B. augmentation allowlist — every program file containing
 *      `declare module 'cordis'` must be individually allowlisted as
 *      browser-safe.
 * Check B is the belt to A's suspenders: it catches node-side merges arriving
 * through files A's patterns don't anticipate.
 *
 * Usage: node gate.mjs <tsconfig> [--expect-fail]
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve, relative, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, '../../../..')
const tsc = resolve(repoRoot, 'node_modules/.bin/tsc')

const tsconfig = process.argv[2]
const expectFail = process.argv.includes('--expect-fail')
if (!tsconfig) {
  console.error('usage: node gate.mjs <tsconfig> [--expect-fail]')
  process.exit(2)
}

/** Node-half patterns (check A). Production version reads this from config. */
const NODE_HALF_PATTERNS = [
  /\/src\/node\.ts$/, // three-entry convention: the node half entry
  /\/packages\/(core\/session|core\/agent|core\/scope|llm\/llm|ui\/user-approval|ui\/user-interaction)\/src\//,
]

/** Browser-safe augmentation sources (check B). Everything else carrying `declare module 'cordis'` fails. */
const AUGMENTATION_ALLOWLIST = new Set([
  'vendor/timer/src/index.ts',
])

const stdout = execFileSync(tsc, ['-p', tsconfig, '--listFilesOnly'], { encoding: 'utf8' })
const files = stdout.split('\n').filter(Boolean).map((f) => resolve(f))
const repoFiles = files
  .filter((f) => f.startsWith(repoRoot) && !f.includes('/node_modules/typescript/'))
  .map((f) => relative(repoRoot, f))

const violations = []

for (const file of repoFiles) {
  if (NODE_HALF_PATTERNS.some((p) => p.test('/' + file))) {
    violations.push(`[closure] node-half file in browser program: ${file}`)
  }
}

for (const file of repoFiles) {
  if (!file.endsWith('.ts')) continue
  const text = readFileSync(resolve(repoRoot, file), 'utf8')
  if (/declare\s+module\s+(['"])cordis\1/.test(text) && !AUGMENTATION_ALLOWLIST.has(file)) {
    violations.push(`[augmentation] non-allowlisted 'cordis' merge in browser program: ${file}`)
  }
}

console.log(`gate: ${tsconfig} — program has ${files.length} files (${repoFiles.length} repo-local)`)
for (const v of violations) console.log('  ' + v)

const failed = violations.length > 0
if (expectFail) {
  console.log(failed ? 'EXPECTED-FAIL: OK (gate caught the smuggle)' : 'EXPECTED-FAIL: MISSED — gate is blind!')
  process.exit(failed ? 0 : 1)
}
console.log(failed ? 'FAIL' : 'PASS')
process.exit(failed ? 1 : 0)
