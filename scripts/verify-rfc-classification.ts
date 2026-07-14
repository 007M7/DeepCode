/**
 * Enforce RFC lifecycle/class paths, dated filenames, and titles; verify the
 * generated index and reject index rows in the curated README. Structural rules
 * and rendering are shared with `rfc-index.ts`; the closed classification
 * contract lives in `docs/rfc/README.md`.
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { INDEX_ROW, renderIndex, rfcRoot, walkRfcTree } from './rfc-index.ts'

const { rfcs, errors } = walkRfcTree()

if (errors.length === 0) {
  let index: string | undefined
  try {
    index = readFileSync(resolve(rfcRoot, 'INDEX.md'), 'utf8')
  } catch {
    // A missing INDEX.md is reported below as staleness, exactly like a drifted one.
  }
  if (renderIndex(rfcs) !== index) {
    errors.push('index: docs/rfc/INDEX.md is stale or missing — run `pnpm run gen-rfc-index` and commit the result')
  }
  const readme = readFileSync(resolve(rfcRoot, 'README.md'), 'utf8')
  for (const line of readme.split('\n')) {
    if (INDEX_ROW.test(line)) {
      errors.push(`readme: index-shaped row in the curated README (the list lives in INDEX.md): ${JSON.stringify(line.slice(0, 80))}`)
    }
  }
}

if (errors.length === 0) {
  console.log(`verify-rfc-classification: ${rfcs.length} RFC(s) checked, structure and index consistent.`)
  process.exit(0)
}

console.error('verify-rfc-classification: violations found:')
for (const e of errors) console.error(`  ${e}`)
process.exit(1)
