/**
 * Doc-sync gate: enforce word-count ceilings on the standing docs that accrete
 * (docs/AGENTS.md § "Budgets and the ceiling gate"). Instruction files and the
 * architecture overview grow a paragraph per PR unless something pushes back;
 * this gate is the pushback — when a ceiling is hit, the fix is to relocate or
 * condense per the documentation standard, not to raise the ceiling. Raising a
 * ceiling is allowed but is a deliberate, reviewable manifest diff that the PR
 * description must justify.
 *
 * Scope is deliberately NARROW: only the files listed in
 * scripts/doc-budgets.manifest.json (path → max words). Reference docs, RFCs,
 * and package READMEs are unbudgeted — length is legitimate there (a feature
 * matrix is the right kind of long), and the standard governs them through
 * review, not a ceiling.
 *
 * The manifest is an enforcement frontier, i18n-rollout style: a ceiling sits
 * at least 5% above the doc's current size (working headroom, so routine
 * wording edits pass while real growth trips the gate) and ratchets DOWN,
 * keeping that margin, as the doc is brought to its target budget. A manifest entry whose file is missing
 * fails the gate, so a rename cannot silently orphan its budget.
 *
 * Words are counted `wc -w` style over the whole file (whitespace-delimited
 * tokens, fenced code included) so a ceiling is reproducible with standard
 * tools. This is a checker, not a formatter: it reports and never rewrites.
 *
 * Run: `tsx scripts/verify-doc-budgets.ts` (or `--list` to print every
 * budgeted doc's current count vs ceiling without failing).
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

const MANIFEST_PATH = resolve(root, 'scripts/doc-budgets.manifest.json')

/** `wc -w` equivalent: count whitespace-delimited tokens. */
function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8')) as Record<string, number>

const listOnly = process.argv.includes('--list')
const failures: string[] = []
const rows: string[] = []

for (const [path, ceiling] of Object.entries(manifest)) {
  if (!Number.isInteger(ceiling) || ceiling <= 0) {
    rows.push(`BAD   ${'—'.padStart(6)} / ${String(ceiling).padEnd(6)} ${path}`)
    failures.push(`${path}: ceiling must be a positive integer, got ${ceiling}`)
    continue
  }
  const abs = resolve(root, path)
  if (!existsSync(abs)) {
    rows.push(`MISS  ${'—'.padStart(6)} / ${String(ceiling).padEnd(6)} ${path}`)
    failures.push(`${path}: budgeted file does not exist (renamed or deleted? update scripts/doc-budgets.manifest.json in the same change)`)
    continue
  }
  const words = countWords(readFileSync(abs, 'utf8'))
  rows.push(`${words <= ceiling ? 'ok  ' : 'OVER'}  ${String(words).padStart(6)} / ${String(ceiling).padEnd(6)} ${path}`)
  if (words > ceiling) {
    failures.push(`${path}: ${words} words exceeds the ${ceiling}-word ceiling — relocate or condense per docs/AGENTS.md (raising the ceiling requires justification in the PR)`)
  }
}

if (listOnly) {
  console.log(rows.join('\n'))
  process.exit(0)
}

if (failures.length > 0) {
  console.error('verify-doc-budgets failed:\n')
  for (const failure of failures) console.error(`  ${failure}`)
  console.error('\nSee docs/AGENTS.md for the documentation standard and the relocation-first rule.')
  process.exit(1)
}

console.log(`verify-doc-budgets: ${Object.keys(manifest).length} budgeted docs within ceiling.`)
