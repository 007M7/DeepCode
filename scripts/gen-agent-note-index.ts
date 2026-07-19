/**
 * Regenerate `.agents/notes/INDEX.md` — the fully generated Agent Note index — from the
 * Agent Note tree (see [agent-note-index.ts](./agent-note-index.ts) for the layout contract and
 * rendering rules). The whole file is generated state; the curated prose lives
 * in `.agents/notes/README.md`. Freshness is asserted by
 * `verify-agent-note-classification.ts` (a `doc-sync` member), so a stale committed
 * index fails CI.
 *
 * Run: `pnpm run gen-agent-note-index`.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { agentNoteRoot, renderIndex, walkAgentNoteTree } from './agent-note-index.ts'

const { notes, errors } = walkAgentNoteTree()
if (errors.length > 0) {
  console.error('gen-agent-note-index: refusing to generate from a structurally invalid tree:')
  for (const e of errors) console.error(`  ${e}`)
  process.exit(1)
}

const indexPath = resolve(agentNoteRoot, 'INDEX.md')
const next = renderIndex(notes)
let current: string | undefined
try {
  current = readFileSync(indexPath, 'utf8')
} catch {
  // Missing INDEX.md is the fresh-generation case, not an error: fall through and write it.
}
if (next === current) {
  console.log(`gen-agent-note-index: .agents/notes/INDEX.md is up to date (${notes.length} Agent Notes).`)
} else {
  writeFileSync(indexPath, next)
  console.log(`gen-agent-note-index: .agents/notes/INDEX.md regenerated (${notes.length} Agent Notes).`)
}
