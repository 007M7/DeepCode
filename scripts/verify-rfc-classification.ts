/**
 * Doc-sync gate: enforce the RFC classification scheme
 * ([the classification RFC](../docs/rfc/implemented/process/2026-06-20-rfc-classification.md)).
 * Every RFC is filed at `docs/rfc/{lifecycle}/{class}/yyyy-mm-dd-topic.md`; the
 * folder IS the label. This gate is the machine source of truth for the closed
 * class set and keeps the README index honest.
 *
 * Two checks:
 *
 * 1. STRUCTURE — every `.md` under a lifecycle folder lives in a class folder
 *    from CLASSES, named `yyyy-mm-dd-*.md`. A loose `.md` directly under a
 *    lifecycle root (other than the README/AGENTS allowlist) fails; an unknown
 *    class folder fails; a stray file at an unexpected depth fails. This is what
 *    makes the set CLOSED: a new class folder can't appear without amending
 *    CLASSES here (and the README's Classification section, per the RFC).
 *
 * 2. COMPLETENESS — `docs/rfc/README.md` lists every RFC exactly once, under the
 *    `### {Class}` heading inside the `## {Lifecycle}` section that matches the
 *    file's path. A missing entry, a duplicate, or an entry under the wrong
 *    heading fails. This mirrors `verify-event-taxonomy`: a curated doc table
 *    checked against the on-disk source of truth, so the index can't drift.
 *
 * The class DESCRIPTIONS in the README prose are not checked (they are
 * explanatory text); only the per-class index tables are. This is checker, not
 * fixer: it reports and never rewrites.
 *
 * Run: `tsx scripts/verify-rfc-classification.ts`.
 */

import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { glob } from 'node:fs/promises'

const root = resolve(import.meta.dirname, '..')
const rfcRoot = resolve(root, 'docs/rfc')

/** The closed set of RFC lifecycles (top-level folders under docs/rfc/). */
const LIFECYCLES = ['proposed', 'implemented', 'rejected'] as const

/**
 * The closed set of RFC classes (nested folder under each lifecycle). Adding a
 * class is a deliberate act: extend this list AND the README's Classification
 * section. The gate rejects any folder not listed here.
 */
const CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'] as const

/** Non-RFC Markdown allowed to sit directly at a lifecycle root. */
const ROOT_ALLOWLIST = new Set(['AGENTS.md', 'CLAUDE.md'])

/** Title-case a class/lifecycle folder name for README heading comparison. */
const heading = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

const errors: string[] = []

// --- Check 1: structure -----------------------------------------------------
// Every Markdown file anywhere under a lifecycle folder, at any depth.
interface Rfc {
  lifecycle: string
  cls: string
  base: string
  /** Path relative to docs/rfc, for the README link check. */
  rel: string
}
const rfcs: Rfc[] = []

for (const lifecycle of LIFECYCLES) {
  for await (const match of glob(`${lifecycle}/**/*.md`, { cwd: rfcRoot })) {
    const segs = match.split('/')
    // Allowlisted file directly at the lifecycle root (e.g. implemented/AGENTS.md).
    if (segs.length === 2 && ROOT_ALLOWLIST.has(segs[1] ?? '')) continue
    const cls = segs[1]
    const base = segs[2]
    if (segs.length !== 3 || cls === undefined || base === undefined) {
      errors.push(`structure: ${match} — expected {lifecycle}/{class}/file.md (got depth ${segs.length})`)
      continue
    }
    if (!(CLASSES as readonly string[]).includes(cls)) {
      errors.push(`structure: ${match} — unknown class folder "${cls}" (allowed: ${CLASSES.join(', ')})`)
      continue
    }
    if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(base)) {
      errors.push(`structure: ${match} — filename must be yyyy-mm-dd-topic.md`)
      continue
    }
    rfcs.push({ lifecycle, cls, base, rel: match })
  }
}

// --- Check 2: README completeness -------------------------------------------
// Parse the index into (lifecycle, class) -> set of linked rel paths, by
// tracking the current `## {Lifecycle}` and `### {Class}` headings and reading
// every `](path)` link target underneath. A link target is normalized to its
// path relative to docs/rfc.
const readmePath = resolve(rfcRoot, 'README.md')
const readme = readFileSync(readmePath, 'utf8')
const lifecycleByHeading = new Map(LIFECYCLES.map((l): [string, string] => [heading(l), l]))
const classByHeading = new Map(CLASSES.map((c): [string, string] => [heading(c), c]))

/** README-listed RFC link targets, keyed `lifecycle/class` -> set of rel paths. */
const listed = new Map<string, Set<string>>()
let curLifecycle: string | null = null
let curClass: string | null = null

for (const line of readme.split('\n')) {
  const h2 = /^##\s+(.+?)\s*$/.exec(line)
  if (h2?.[1] !== undefined) {
    curLifecycle = lifecycleByHeading.get(h2[1].trim()) ?? null
    curClass = null
    continue
  }
  const h3 = /^###\s+(.+?)\s*$/.exec(line)
  if (h3?.[1] !== undefined) {
    curClass = classByHeading.get(h3[1].trim()) ?? null
    continue
  }
  if (!curLifecycle || !curClass) continue
  // Collect every relative .md link target on this line.
  for (const m of line.matchAll(/\]\(([^)]+\.md)[^)]*\)/g)) {
    const target = m[1]
    if (target === undefined) continue
    // README links are relative to docs/rfc; normalize and key by location.
    const rel = relative(rfcRoot, resolve(rfcRoot, target))
    const key = `${curLifecycle}/${curClass}`
    const set = listed.get(key) ?? new Set<string>()
    set.add(rel)
    listed.set(key, set)
  }
}

// Every on-disk RFC must be listed under the heading matching its path.
const seenOnDisk = new Set<string>()
for (const rfc of rfcs) {
  seenOnDisk.add(rfc.rel)
  const key = `${rfc.lifecycle}/${rfc.cls}`
  if (!listed.get(key)?.has(rfc.rel)) {
    errors.push(
      `index: ${rfc.rel} is not listed in README under "## ${heading(rfc.lifecycle)}" → "### ${heading(rfc.cls)}"`,
    )
  }
}

// Every README entry must point at a real RFC under that same heading (catches a
// misfiled or stale row).
for (const [key, targets] of listed) {
  for (const rel of targets) {
    if (!seenOnDisk.has(rel)) {
      errors.push(`index: README lists "${rel}" under "${key}", but no such RFC exists`)
    }
  }
}

// --- Report -----------------------------------------------------------------
if (errors.length === 0) {
  console.log(`verify-rfc-classification: ${rfcs.length} RFC(s) checked, structure and index consistent.`)
  process.exit(0)
}

console.error('verify-rfc-classification: violations found:')
for (const e of errors) console.error(`  ${e}`)
process.exit(1)
