/**
 * Doc-sync gate: enforce the RFC classification scheme
 * ([the classification RFC](../docs/rfc/implemented/process/2026-06-20-rfc-classification.md))
 * and the freshness of the generated index
 * ([the index-generation RFC](../docs/rfc/implemented/process/2026-07-04-generate-rfc-index-tables.md)).
 * Every RFC is filed at `docs/rfc/{lifecycle}/{class}/yyyy-mm-dd-topic.md`; the
 * folder IS the label. This gate is the machine source of truth for the closed
 * class set and keeps the generated index honest.
 *
 * Three checks (all against [rfc-index.ts](./rfc-index.ts), the shared walker
 * and renderer):
 *
 * 1. STRUCTURE — every `.md` under a lifecycle folder lives in a class folder
 *    from CLASSES, is named `yyyy-mm-dd-*.md`, and opens with a parseable H1.
 *    A loose `.md` directly under a lifecycle root (other than the
 *    README/AGENTS allowlist) fails; an unknown class folder fails; a stray
 *    file at an unexpected depth fails. This is what makes the set CLOSED: a
 *    new class folder can't appear without amending CLASSES (and the README's
 *    Classification section, per the RFC).
 * 2. FRESHNESS — the committed `docs/rfc/INDEX.md` byte-matches a fresh render
 *    from the tree, so every RFC is listed exactly once, under the heading
 *    matching its path, with its H1 title and filename date. The fix for a
 *    stale index is `pnpm run gen-rfc-index`, never a hand edit. This is
 *    checker, not fixer: it reports and never rewrites.
 * 3. NO STRAY ROWS — `docs/rfc/README.md` (the curated front door) carries no
 *    index-shaped table rows; the list lives only in the generated INDEX.md.
 *
 * Run: `tsx scripts/verify-rfc-classification.ts`.
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
