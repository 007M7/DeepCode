/**
 * Shared source of truth for the RFC index: the tree walker (structure rules) and the README
 * table renderer. `gen-rfc-index.ts` writes the generated regions;
 * `verify-rfc-classification.ts` checks structure and asserts the committed regions are fresh.
 * Lifecycle and class sets are closed under `docs/rfc/README.md`; rows derive
 * from path, H1, and filename date and sort deterministically. Import is pure.
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

/**
 * Render one lifecycle's section body: a `### {Class}` heading plus a
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
 * Render the complete `docs/rfc/INDEX.md` content: a generated-file banner
 * followed by one `## {Lifecycle}` section per lifecycle in canonical order.
 * The whole file is generated state — there is no curated region to preserve.
 */
export function renderIndex(rfcs: Rfc[]): string {
  const parts = [
    '# RFC index',
    '',
    'Generated by `pnpm run gen-rfc-index` from the RFC tree — never edit by hand; `verify-rfc-classification` fails when this file is stale. The curated front door — layout, classification, when to write one, and the in-file format — is [README.md](README.md).',
  ]
  for (const lifecycle of LIFECYCLES) {
    parts.push('', `## ${heading(lifecycle)}`, '', renderLifecycle(rfcs, lifecycle))
  }
  return `${parts.join('\n')}\n`
}

/** Matches an index-shaped table row (a `| [title](lifecycle/…) |` line) — generated state that must not appear in curated prose. */
export const INDEX_ROW = /^\|\s*\[[^\]]+\]\((?:proposed|implemented|rejected)\//
