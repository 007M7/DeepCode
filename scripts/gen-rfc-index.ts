/**
 * Regenerate `docs/rfc/INDEX.md` — the fully generated RFC index — from the
 * RFC tree (see [rfc-index.ts](./rfc-index.ts) for the layout contract and
 * rendering rules). The whole file is generated state; the curated prose lives
 * in `docs/rfc/README.md`. Freshness is asserted by
 * `verify-rfc-classification.ts` (a `doc-sync` member), so a stale committed
 * index fails CI.
 *
 * Run: `pnpm run gen-rfc-index`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { renderIndex, rfcRoot, walkRfcTree } from './rfc-index.ts'

const { rfcs, errors } = walkRfcTree()
if (errors.length > 0) {
  console.error('gen-rfc-index: refusing to generate from a structurally invalid tree:')
  for (const e of errors) console.error(`  ${e}`)
  process.exit(1)
}

const indexPath = resolve(rfcRoot, 'INDEX.md')
const next = renderIndex(rfcs)
let current: string | undefined
try {
  current = readFileSync(indexPath, 'utf8')
} catch {
  // Missing INDEX.md is the fresh-generation case, not an error: fall through and write it.
}
if (next === current) {
  console.log(`gen-rfc-index: docs/rfc/INDEX.md is up to date (${rfcs.length} RFCs).`)
} else {
  writeFileSync(indexPath, next)
  console.log(`gen-rfc-index: docs/rfc/INDEX.md regenerated (${rfcs.length} RFCs).`)
}
