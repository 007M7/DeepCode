/**
 * Enforce Agent Note lifecycle/class paths, dated filenames, and titles; verify the
 * generated index and reject index rows in the curated README. Structural rules
 * and rendering are shared with `agent-note-index.ts`; the closed classification
 * contract lives in `.agents/notes/README.md`.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { agentNoteRoot, INDEX_ROW, renderIndex, walkAgentNoteTree } from './agent-note-index.ts'

const { notes, errors } = walkAgentNoteTree()

// Keep the former homes unavailable so new notes cannot silently escape this tree.
for (const legacyRoot of ['docs/rfc', 'docs/rfcs']) {
  if (existsSync(resolve(import.meta.dirname, '..', legacyRoot))) {
    errors.push(`legacy-path: ${legacyRoot}/ is forbidden — put Agent Notes under .agents/notes/`)
  }
}

if (errors.length === 0) {
  let index: string | undefined
  try {
    index = readFileSync(resolve(agentNoteRoot, 'INDEX.md'), 'utf8')
  } catch {
    // A missing INDEX.md is reported below as staleness, exactly like a drifted one.
  }
  if (renderIndex(notes) !== index) {
    errors.push('index: .agents/notes/INDEX.md is stale or missing — run `pnpm run gen-agent-note-index` and commit the result')
  }
  const readme = readFileSync(resolve(agentNoteRoot, 'README.md'), 'utf8')
  for (const line of readme.split('\n')) {
    if (INDEX_ROW.test(line)) {
      errors.push(`readme: index-shaped row in the curated README (the list lives in INDEX.md): ${JSON.stringify(line.slice(0, 80))}`)
    }
  }
}

if (errors.length === 0) {
  console.log(`verify-agent-note-classification: ${notes.length} Agent Note(s) checked, structure and index consistent.`)
  process.exit(0)
}

console.error('verify-agent-note-classification: violations found:')
for (const e of errors) console.error(`  ${e}`)
process.exit(1)
