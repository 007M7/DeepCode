/**
 * Doc-sync gate (doc-sync-enforcement RFC, part 2): verify the event-taxonomy table in
 * docs/architecture.md against the events actually declared in source.
 *
 * The table duplicates the `declare module 'cordis' { interface Events }`
 * blocks across packages/* /src. This script extracts both sets of event names
 * and asserts they match exactly — every declared event appears in the table,
 * and the table names no event that isn't declared. Verify, don't generate
 * (per the RFC): the table keeps its hand-written Mode/Purpose columns; only
 * the set of names is checked.
 *
 * Run: `tsx scripts/verify-event-taxonomy.ts`.
 */

import { readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { glob } from 'node:fs/promises'

const root = resolve(import.meta.dirname, '..')

/**
 * Remove `/* *​/` block comments and `//` line comments from TS source. Used to
 * de-risk the brace walk in {@link declaredEvents} — a JSDoc `{@link}` tag would
 * otherwise throw off the `{`/`}` depth counter. Good enough for our own source
 * (no string literals contain `//` or comment-like brace sequences in an Events
 * block); it is not a general tokenizer.
 */
function stripComments(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/**
 * Event names declared in source: the keys inside every `interface Events`
 * block under packages/* /src. A declared event is a quoted `'scope/name'(`
 * method signature at the start of a line within such a block.
 */
async function declaredEvents(): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for await (const match of glob('packages/*/src/**/*.ts', { cwd: root })) {
    const abs = resolve(root, match)
    // Strip comments first so a JSDoc `{@link …}` tag (or a `// {` line) inside
    // an Events block can't unbalance the brace walk below. Event names live in
    // code, never in comments, so this loses nothing.
    const text = stripComments(readFileSync(abs, 'utf8'))
    // Walk `interface Events {` blocks brace-balanced and pull quoted keys.
    const re = /interface\s+Events\s*\{/g
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      let depth = 1
      let i = m.index + m[0].length
      const start = i
      while (i < text.length && depth > 0) {
        const ch = text[i]
        if (ch === '{') depth++
        else if (ch === '}') depth--
        i++
      }
      const body = text.slice(start, i - 1)
      // A declaration is a quoted event name followed by `(` (method form).
      for (const k of body.matchAll(/['"]([a-z][a-z-]*\/[a-z-]+)['"]\s*\(/g)) {
        const name = k[1]
        if (name) found.set(name, relative(root, abs))
      }
    }
  }
  return found
}

/** Event names referenced in the architecture-doc taxonomy table (in `code`). */
function tableEvents(): Set<string> {
  const text = readFileSync(join(root, 'docs/architecture.md'), 'utf8')
  const lines = text.split('\n')
  const heading = lines.findIndex(l => /^###\s+Event taxonomy/.test(l))
  if (heading === -1) throw new Error('verify-event-taxonomy: "### Event taxonomy" heading not found')
  const names = new Set<string>()
  for (let i = heading + 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (/^###\s/.test(line)) break // next section ends the table
    if (!line.includes('|')) continue
    for (const code of line.matchAll(/`([^`]+)`/g)) {
      // A cell may read "`a/b` / `c/d` (pkg)" — pull each scoped name.
      for (const name of (code[1] ?? '').matchAll(/[a-z][a-z-]*\/[a-z-]+/g)) names.add(name[0])
    }
  }
  return names
}

const declared = await declaredEvents()
const table = tableEvents()

const declaredNames = new Set(declared.keys())
const missingFromTable = [...declaredNames].filter(n => !table.has(n)).sort()
const missingFromSource = [...table].filter(n => !declaredNames.has(n)).sort()

if (missingFromTable.length === 0 && missingFromSource.length === 0) {
  console.log(`verify-event-taxonomy: ${declaredNames.size} events match the architecture-doc table.`)
  process.exit(0)
}

if (missingFromTable.length > 0) {
  console.error('verify-event-taxonomy: declared in source but MISSING from the docs/architecture.md table:')
  for (const n of missingFromTable) {
    console.error(`  ${n}  (declared in ${declared.get(n) ?? '?'})`)
  }
}
if (missingFromSource.length > 0) {
  console.error('verify-event-taxonomy: named in the table but NOT declared in source (stale doc):')
  for (const n of missingFromSource) {
    console.error(`  ${n}`)
  }
}
process.exit(1)
