/**
 * Shared source of truth for the Agent Note index: the tree walker (structure rules) and the README
 * table renderer. `gen-agent-note-index.ts` writes the generated regions;
 * `verify-agent-note-classification.ts` checks structure and asserts the committed regions are fresh.
 * Lifecycle and class sets are closed under `.agents/notes/README.md`; rows derive
 * from path, H1, and filename date and sort deterministically. Import is pure.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { globSync } from 'node:fs'

export const agentNoteRoot = resolve(import.meta.dirname, '../.agents/notes')

/** The closed set of Agent Note lifecycles (top-level folders under .agents/notes/). */
const LIFECYCLES = ['proposed', 'implemented', 'rejected'] as const

/**
 * The closed set of Agent Note classes (nested folder under each lifecycle). Adding a
 * class is a deliberate act: extend this list AND the README's Classification
 * section. The gate rejects any folder not listed here.
 */
const CLASSES = ['feature', 'bug-fix', 'simplification', 'architecture', 'process', 'testing'] as const

/** Non-Agent Note Markdown allowed to sit directly at a lifecycle root. */
const ROOT_ALLOWLIST = new Set(['AGENTS.md', 'CLAUDE.md'])

/** Title-case a class/lifecycle folder name for a README heading. */
const heading = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

/** One Agent Note file, as discovered by the walker. */
export interface AgentNote {
  lifecycle: string
  cls: string
  base: string
  /** Path relative to .agents/notes — the README link target. */
  rel: string
  /** H1 text with any `Agent Note: ` prefix stripped — the README row title. */
  title: string
  /** `yyyy-mm-dd` from the filename — the "First proposed" column. */
  date: string
}

/**
 * Walk the Agent Note tree, enforcing the structure rules. Returns every valid Agent Note
 * plus one error string per violation (unknown lifecycle or class folder, bad
 * depth, bad filename, missing/malformed H1). Callers treat a non-empty error
 * list as fatal — the index is only generated from a structurally valid tree.
 */
export function walkAgentNoteTree(): { notes: AgentNote[]; errors: string[] } {
  const notes: AgentNote[] = []
  const errors: string[] = []
  // The lifecycle set is closed too: any directory under .agents/notes/ that is not
  // a known lifecycle would otherwise hold Agent Notes invisible to the walk below.
  for (const entry of readdirSync(agentNoteRoot, { withFileTypes: true })) {
    if (entry.isDirectory() && !(LIFECYCLES as readonly string[]).includes(entry.name)) {
      errors.push(`structure: ${entry.name}/ — unknown lifecycle folder (allowed: ${LIFECYCLES.join(', ')})`)
    }
  }
  for (const lifecycle of LIFECYCLES) {
    for (const match of globSync(`${lifecycle}/**/*.md`, { cwd: agentNoteRoot }).map(path => path.split(sep).join('/')).sort()) {
      const segs = match.split('/')
      // Allowlisted file directly at the lifecycle root (e.g. implemented/AGENTS.md).
      if (segs.length === 2 && ROOT_ALLOWLIST.has(segs[1] ?? '')) continue
      // A Chinese counterpart (foo.zh.md, docs/i18n/README.md) is the SAME Agent Note,
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
      const firstLine = readFileSync(resolve(agentNoteRoot, match), 'utf8').split('\n', 1)[0] ?? ''
      const h1 = /^#\s+(?:Agent Note:\s+)?(.+?)\s*$/.exec(firstLine)
      if (!h1?.[1]) {
        errors.push(`title: ${match} — first line must be an H1 (\`# Agent Note: <title>\` or \`# <title>\`), got: ${JSON.stringify(firstLine)}`)
        continue
      }
      notes.push({ lifecycle, cls, base, rel: match, title: h1[1], date: base.slice(0, 10) })
    }
  }
  return { notes, errors }
}

/**
 * Render one lifecycle's section body: a `### {Class}` heading plus a
 * `| Title | First proposed |` table for every non-empty class, in CLASSES
 * order, rows sorted by date then filename.
 */
function renderLifecycle(notes: AgentNote[], lifecycle: string): string {
  const sections: string[] = []
  for (const cls of CLASSES) {
    const rows = notes
      .filter(r => r.lifecycle === lifecycle && r.cls === cls)
      .sort((a, b) => a.date.localeCompare(b.date) || a.base.localeCompare(b.base))
    if (rows.length === 0) continue
    const table = rows.map(r => `| [${r.title}](${r.rel}) | ${r.date} |`).join('\n')
    sections.push(`### ${heading(cls)}\n\n| Title | First proposed |\n|---|---|\n${table}`)
  }
  return sections.join('\n\n')
}

/**
 * Render the complete `.agents/notes/INDEX.md` content: a generated-file banner
 * followed by one `## {Lifecycle}` section per lifecycle in canonical order.
 * The whole file is generated state — there is no curated region to preserve.
 */
export function renderIndex(notes: AgentNote[]): string {
  const parts = [
    '# Agent Note index',
    '',
    'Generated by `pnpm run gen-agent-note-index` from the Agent Note tree — never edit by hand; `verify-agent-note-classification` fails when this file is stale. The curated front door — layout, classification, when to write one, and the in-file format — is [README.md](README.md).',
  ]
  for (const lifecycle of LIFECYCLES) {
    parts.push('', `## ${heading(lifecycle)}`, '', renderLifecycle(notes, lifecycle))
  }
  return `${parts.join('\n')}\n`
}

/** Matches an index-shaped table row (a `| [title](lifecycle/…) |` line) — generated state that must not appear in curated prose. */
export const INDEX_ROW = /^\|\s*\[[^\]]+\]\((?:proposed|implemented|rejected)\//
