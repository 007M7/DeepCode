/**
 * Regenerate the RFC index tables in `docs/rfc/README.md` from the RFC tree
 * (see [rfc-index.ts](./rfc-index.ts) for the layout contract and rendering
 * rules). Rewrites ONLY the marker-delimited regions; the curated prose is
 * untouched. Freshness is asserted by `verify-rfc-classification.ts` (a
 * `doc-sync` member), so a stale committed index fails CI.
 *
 * Run: `pnpm run gen-rfc-index`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { rfcRoot, spliceReadme, walkRfcTree } from './rfc-index.ts'

const { rfcs, errors } = walkRfcTree()
if (errors.length > 0) {
  console.error('gen-rfc-index: refusing to generate from a structurally invalid tree:')
  for (const e of errors) console.error(`  ${e}`)
  process.exit(1)
}

const readmePath = resolve(rfcRoot, 'README.md')
const readme = readFileSync(readmePath, 'utf8')
const next = spliceReadme(readme, rfcs)
if (next === readme) {
  console.log(`gen-rfc-index: docs/rfc/README.md is up to date (${rfcs.length} RFCs).`)
} else {
  writeFileSync(readmePath, next)
  console.log(`gen-rfc-index: docs/rfc/README.md regenerated (${rfcs.length} RFCs).`)
}
