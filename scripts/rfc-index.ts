/**
 * Shared source of truth for the RFC index: the tree walker (structure rules)
 * and the README table renderer. `gen-rfc-index.ts` writes the generated
 * regions; `verify-rfc-classification.ts` checks structure and asserts the
 * committed regions are fresh. Pure module — no side effects on import.
 *
 * The layout contract ([the classification RFC](../docs/rfc/implemented/process/2026-06-20-rfc-classification.md)):
 * every RFC lives at `docs/rfc/{lifecycle}/{class}/yyyy-mm-dd-topic.md`, the
 * folder IS the label, and both sets are CLOSED — extending either means
 * amending this module AND the README's Classification prose.
 *
 * The README's per-lifecycle tables are GENERATED between marker comments
 * (`<!-- gen-rfc-index:begin {lifecycle} -->` … `end`): section headings and
 * rows are derived from each RFC's path (lifecycle/class), H1 (title, with an
 * optional `RFC: ` prefix stripped), and filename date, sorted by date then
 * filename. Prose outside the markers is curated by hand and never touched.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { globSync } from 'node:fs'

export const rfcRoot = resolve(import.meta.dirname, '../docs/rfc')

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

/** Title-case a class/lifecycle folder name for a README heading. */
const heading = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** One RFC file, as discovered by the walker. */
export interface Rfc {
  lifecycle: string
  cls: string
  base: string
  /** Path relative to docs/rfc — the README link target. */
  rel: string
  /** H1 text with any `RFC: ` prefix stripped — the README row title. */
  title: string
  /** `yyyy-mm-dd` from the filename — the "First proposed" column. */
  date: string
}

/**
 * Walk the RFC tree, enforcing the structure rules. Returns every valid RFC
 * plus one error string per violation (unknown lifecycle or class folder, bad
 * depth, bad filename, missing/malformed H1). Callers treat a non-empty error
 * list as fatal — the index is only generated from a structurally valid tree.
 */
export function walkRfcTree(): { rfcs: Rfc[]; errors: string[] } {
  const rfcs: Rfc[] = []
  const errors: string[] = []
  // The lifecycle set is closed too: any directory under docs/rfc/ that is not
  // a known lifecycle would otherwise hold RFCs invisible to the walk below.
  for (const entry of readdirSync(rfcRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !(LIFECYCLES as readonly string[]).includes(entry.name)) {
      errors.push(`structure: ${entry.name}/ — unknown lifecycle folder (allowed: ${LIFECYCLES.join(', ')})`)
    }
  }
  for (const lifecycle of LIFECYCLES) {
    for (const match of globSync(`${lifecycle}/**/*.md`, { cwd: rfcRoot }).sort()) {
      const segs = match.split('/')
      // Allowlisted file directly at the lifecycle root (e.g. implemented/AGENTS.md).
      if (segs.length === 2 && ROOT_ALLOWLIST.has(segs[1] ?? '')) continue
      // A Chinese counterpart (foo.zh.md, docs/i18n/README.md) is the SAME RFC,
      // indexed via its English filename; the pairing gate owns its consistency.
      if (match.endsWith('.zh.md')) continue
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
      const firstLine = readFileSync(resolve(rfcRoot, match), 'utf8').split('\n', 1)[0] ?? ''
      const h1 = /^#\s+(?:RFC:\s+)?(.+?)\s*$/.exec(firstLine)
      if (!h1?.[1]) {
        errors.push(`title: ${match} — first line must be an H1 (\`# RFC: <title>\` or \`# <title>\`), got: ${JSON.stringify(firstLine)}`)
        continue
      }
      rfcs.push({ lifecycle, cls, base, rel: match, title: h1[1], date: base.slice(0, 10) })
    }
  }
  return { rfcs, errors }
}

/** The begin/end marker lines that delimit one lifecycle's generated region. */
const markers = (lifecycle: string): { begin: string; end: string } => ({
  begin: `<!-- gen-rfc-index:begin ${lifecycle} -->`,
  end: `<!-- gen-rfc-index:end ${lifecycle} -->`,
})

/**
 * Render one lifecycle's generated region body: a `### {Class}` heading plus a
 * `| Title | First proposed |` table for every non-empty class, in CLASSES
 * order, rows sorted by date then filename.
 */
function renderLifecycle(rfcs: Rfc[], lifecycle: string): string {
  const sections: string[] = []
  for (const cls of CLASSES) {
    const rows = rfcs
      .filter(r => r.lifecycle === lifecycle && r.cls === cls)
      .sort((a, b) => a.date.localeCompare(b.date) || a.base.localeCompare(b.base))
    if (rows.length === 0) continue
    const table = rows.map(r => `| [${r.title}](${r.rel}) | ${r.date} |`).join('\n')
    sections.push(`### ${heading(cls)}\n\n| Title | First proposed |\n|---|---|\n${table}`)
  }
  return sections.join('\n\n')
}

/**
 * Splice freshly rendered regions into the README text. Throws when a marker
 * pair is missing, duplicated, or out of order, when a region does not sit
 * under its own `## {Lifecycle}` heading, or when an index-shaped table row
 * (a `| [title](lifecycle/…)` line) appears OUTSIDE the generated regions —
 * the markers are part of the curated prose, the heading above each region is
 * the one its lifecycle names, and index rows live only inside the regions
 * (prose links to RFCs remain fine anywhere).
 */
export function spliceReadme(readme: string, rfcs: Rfc[]): string {
  let out = readme
  const regions: Array<{ from: number; to: number }> = []
  for (const lifecycle of LIFECYCLES) {
    const { begin, end } = markers(lifecycle)
    const beginAt = out.indexOf(begin)
    const endAt = out.indexOf(end)
    if (beginAt === -1 || endAt === -1 || endAt < beginAt) {
      throw new Error(`README.md is missing the ${JSON.stringify(begin)} … ${JSON.stringify(end)} marker pair`)
    }
    if (out.indexOf(begin, beginAt + 1) !== -1 || out.indexOf(end, endAt + 1) !== -1) {
      throw new Error(`README.md has a duplicated ${lifecycle} index marker`)
    }
    // The region must sit directly under its own lifecycle heading: the last
    // H2 above the begin marker is `## {Heading(lifecycle)}`, or the heading
    // itself has drifted while the generated table stayed put.
    const before = out.slice(0, beginAt)
    const lastH2 = [...before.matchAll(/^##\s+(.+?)\s*$/gm)].at(-1)?.[1]
    if (lastH2 !== heading(lifecycle)) {
      throw new Error(`README.md: the ${lifecycle} index region is not under a "## ${heading(lifecycle)}" heading (found "## ${lastH2 ?? '<none>'}")`)
    }
    out = `${out.slice(0, beginAt + begin.length)}\n${renderLifecycle(rfcs, lifecycle)}\n${out.slice(endAt)}`
    regions.push({ from: out.indexOf(begin), to: out.indexOf(markers(lifecycle).end) + markers(lifecycle).end.length })
  }
  // Index rows are generated state: a table row linking into a lifecycle
  // folder anywhere OUTSIDE the regions is a hand-added index entry the
  // generator would never reconcile.
  let offset = 0
  for (const line of out.split('\n')) {
    const inRegion = regions.some(r => offset >= r.from && offset < r.to)
    if (!inRegion && /^\|\s*\[[^\]]+\]\((?:proposed|implemented|rejected)\//.test(line)) {
      throw new Error(`README.md: index-shaped row outside the generated regions: ${JSON.stringify(line.slice(0, 80))}`)
    }
    offset += line.length + 1
  }
  return out
}
