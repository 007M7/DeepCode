/** Generate or verify package-owned invariant companion baselines. */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  GENERATED_INVARIANT_MARKER,
  collectPackageInvariantViolations,
  formatPackageInvariantViolation,
  packageInvariantOwners,
  renderBaselineInvariant,
} from './package-invariants.ts'

const root = resolve(import.meta.dirname, '..')
const check = process.argv.includes('--check')

if (!check) {
  let generated = 0
  for (const owner of packageInvariantOwners(root)) {
    const path = resolve(root, owner.sourcePath)
    let current: string | undefined
    try {
      current = readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (current !== undefined && !current.includes(GENERATED_INVARIANT_MARKER)) continue
    const expected = renderBaselineInvariant(owner)
    if (current === expected) continue
    writeFileSync(path, expected)
    generated += 1
  }
  console.log(`gen-package-invariants: wrote ${generated} generated baseline companion(s).`)
}

const violations = collectPackageInvariantViolations(root)
if (violations.length > 0) {
  console.error('verify-package-invariants: violations found:')
  for (const violation of violations) {
    console.error(`  ${formatPackageInvariantViolation(root, violation)}`)
  }
  process.exit(1)
}

console.log(`verify-package-invariants: ${packageInvariantOwners(root).length} package companion(s) conform.`)
