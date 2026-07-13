/**
 * Scoped-dispatch drift gate: the set of scope-filtered events is declared in
 * TWO places that must never diverge — the dev-invariants runtime table (the
 * `scopedSubject` map in `packages/support/invariants/src/index.ts`, which
 * enforces carriers at dispatch time) and the event declarations' JSDoc (the
 * "Scope-filtered dispatch" sentence rendered into the events catalog, which
 * tells plugin authors what a scoped listener will and won't hear). An event
 * added to one side without the other either silently escapes runtime
 * enforcement or documents filtering that never happens; this gate fails the
 * build instead.
 *
 * Sources of truth: the invariant table is parsed from the invariants source;
 * the documented set is parsed from every `declare module 'cordis'` Events
 * JSDoc in packages/*\/*\/src carrying the marker sentence. Registry-subject
 * notifications (`tools/change`, `system-prompt/change`, `subagent/provider-*`)
 * are deliberately unfiltered and must appear in NEITHER set.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** The marker sentence every scope-filtered event's JSDoc carries. */
const MARKER = 'Scope-filtered dispatch'

/** Events that are deliberately UNFILTERED registry-subject notifications. */
const REGISTRY_SUBJECT = new Set(['tools/change', 'system-prompt/change', 'subagent/provider-added', 'subagent/provider-removed'])

function invariantTable(): Set<string> {
  const source = readFileSync(resolve(root, 'packages/support/invariants/src/index.ts'), 'utf8')
  const start = source.indexOf('const scopedSubject')
  if (start < 0) throw new Error('verify-scoped-dispatch: cannot find the scopedSubject table in dsh-invariants')
  const block = source.slice(start, source.indexOf('}', start))
  return new Set([...block.matchAll(/'([a-z-]+\/[a-z-]+)':/g)].flatMap(match => match[1] === undefined ? [] : [match[1]]))
}

function documentedSet(): Set<string> {
  const documented = new Set<string>()
  for (const rel of globSync('packages/*/*/src/**/*.ts', { cwd: root })) {
    const source = readFileSync(resolve(root, rel), 'utf8')
    if (!source.includes(MARKER)) continue
    // Each event declaration: a JSDoc block followed by the quoted event name.
    // Tolerate `//` comment lines between the JSDoc and the declaration
    // (e.g. an inline TODO under the doc block).
    for (const match of source.matchAll(/\/\*\*([\s\S]*?)\*\/\s*\n(?:\s*\/\/[^\n]*\n)*\s*'([a-z-]+\/[a-z-]+)'\(/g)) {
      const [, doc, event] = match
      if (doc === undefined || event === undefined) continue
      if (doc.includes(MARKER)) documented.add(event)
    }
  }
  return documented
}

const table = invariantTable()
const documented = documentedSet()

const problems: string[] = []
for (const event of table) {
  if (!documented.has(event)) {
    problems.push(`"${event}" is enforced by the dev-invariants carrier table but its declaration JSDoc carries no "${MARKER}" sentence — document the filtering plugin authors will observe.`)
  }
  if (REGISTRY_SUBJECT.has(event)) {
    problems.push(`"${event}" is a registry-subject notification (deliberately unfiltered) but appears in the dev-invariants carrier table.`)
  }
}
for (const event of documented) {
  if (!table.has(event)) {
    problems.push(`"${event}" documents scope-filtered dispatch but is missing from the dev-invariants carrier table (packages/support/invariants) — a bare dispatch of it would silently revert to global delivery.`)
  }
}

if (problems.length > 0) {
  console.error(`verify-scoped-dispatch: ${problems.length} drift(s) between the invariant table and the documented scoped-event set:`)
  for (const problem of problems) console.error(`  - ${problem}`)
  process.exit(1)
}
console.log(`verify-scoped-dispatch: ${table.size} scope-filtered event(s) consistent between the invariant table and the declaration docs.`)
