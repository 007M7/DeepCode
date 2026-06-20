/**
 * Doc-sync gate: enforce the repo's "Markdown is not hard-wrapped" convention
 * (AGENTS.md § Type Safety and Documentation) — prose paragraphs are written as
 * one physical line per paragraph and the editor soft-wraps. A hard-wrapped
 * paragraph (a one-word edit reflows and re-diffs the whole block) is a defect
 * this script catches before review.
 *
 * Detection is AST-based: we parse each file with mdast-util-from-markdown (the
 * CommonMark parser behind remark) plus the GFM extension, then flag any
 * `paragraph` node whose source span covers more than one line. The parser owns
 * all the structure that legitimately occupies multiple lines — fenced code
 * (any fence length), tables, list items, blockquotes, HTML blocks, headings,
 * thematic breaks, link-reference definitions — so a hard wrap is simply "a
 * paragraph node that starts and ends on different lines." This is checker, not
 * formatter: it reports and never rewrites, so it introduces zero cosmetic
 * churn (no emphasis-marker or table-delimiter normalization).
 *
 * A wrapped paragraph inside a list item or blockquote is still a `paragraph`
 * node, so those are caught too. Scope mirrors doc-typecheck plus the two
 * AGENTS.md files that doc-sync does NOT otherwise cover (the convention itself
 * lives there): README.md, docs/** /*.md, packages/* /*.md, AGENTS.md,
 * packages/AGENTS.md. The root and packages/ CLAUDE.md are symlinks to the
 * AGENTS.md files, so they are deduped by real path.
 *
 * Run: `tsx scripts/verify-md-wrap.ts`.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { glob } from 'node:fs/promises'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes } from 'mdast'

const root = resolve(import.meta.dirname, '..')

/** Files to check: doc-typecheck's scope plus the AGENTS.md pair. */
const PATTERNS = ['README.md', 'docs/**/*.md', 'packages/*/*.md', 'AGENTS.md', 'packages/AGENTS.md']

/** A located hard-wrap: a prose paragraph spanning more than one source line. */
interface Violation {
  file: string
  /** 1-based line where the hard-wrapped paragraph starts. */
  line: number
  text: string
}

/** Find every hard-wrapped prose paragraph in one Markdown file via its AST. */
function findViolations(absPath: string): Violation[] {
  const file = relative(root, absPath)
  const source = readFileSync(absPath, 'utf8')
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const out: Violation[] = []

  const visit = (node: Nodes): void => {
    if (node.type === 'paragraph' && node.position) {
      const { start, end } = node.position
      if (end.line > start.line) {
        const firstLine = source.split('\n')[start.line - 1] ?? ''
        out.push({ file, line: start.line, text: firstLine.trim() })
      }
      // A paragraph's children are inline (text/emphasis/…); no nested
      // paragraphs to find, so don't descend.
      return
    }
    if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }
  visit(tree)
  return out
}

const seen = new Set<string>()
const all: Violation[] = []
let checked = 0
for (const pattern of PATTERNS) {
  for await (const match of glob(pattern, { cwd: root })) {
    const abs = resolve(root, match)
    // CLAUDE.md symlinks resolve onto AGENTS.md; dedupe by real path so a file
    // matched twice (or via symlink) is checked once.
    const real = realpathSync(abs)
    if (seen.has(real)) continue
    seen.add(real)
    checked++
    all.push(...findViolations(abs))
  }
}

if (all.length === 0) {
  console.log(`verify-md-wrap: ${checked} file(s) checked, no hard-wrapped prose paragraphs.`)
  process.exit(0)
}

console.error('verify-md-wrap: hard-wrapped prose paragraphs found (write one physical line per paragraph):')
for (const v of all) {
  console.error(`  ${v.file}:${v.line}  ${v.text.slice(0, 80)}${v.text.length > 80 ? '…' : ''}`)
}
process.exit(1)
