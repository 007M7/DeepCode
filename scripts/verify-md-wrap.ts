/**
 * Doc-sync gate: enforce the repo's "Markdown is not hard-wrapped" convention
 * (docs/AGENTS.md § Writing rules) — prose paragraphs are written as
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
 * lives there), plus generated system-prompt Markdown goldens: README.md,
 * docs/** /*.md, packages/* /*.md, examples/** /system-prompt.golden.md,
 * packages/** /system-prompt.golden.md, AGENTS.md, packages/AGENTS.md. The root
 * and packages/ CLAUDE.md are symlinks to the AGENTS.md files, so they are
 * deduped by real path.
 *
 * Run: `tsx scripts/verify-md-wrap.ts`.
 */

import { readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import type { Nodes } from 'mdast'
import { parseMarkdown, visitMarkdown } from './markdown.ts'
import { uniqueRepoFiles } from './repo-files.ts'

const root = resolve(import.meta.dirname, '..')

/** Files to check: doc-typecheck's scope, prompt goldens, and the AGENTS.md pair. */
const PATTERNS = [
  'README.md',
  'README.zh.md',
  'docs/**/*.md',
  'packages/*/*.md',
  'packages/*/*/*.md',
  'examples/**/system-prompt.golden.md',
  'packages/**/system-prompt.golden.md',
  'AGENTS.md',
  'packages/AGENTS.md',
]

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
  const tree = parseMarkdown(source)
  const out: Violation[] = []

  visitMarkdown(tree, (node: Nodes): boolean | void => {
    if (node.type === 'paragraph' && node.position) {
      const { start, end } = node.position
      if (end.line > start.line) {
        const firstLine = source.split('\n')[start.line - 1] ?? ''
        out.push({ file, line: start.line, text: firstLine.trim() })
      }
      // A paragraph's children are inline (text/emphasis/…); no nested
      // paragraphs to find, so don't descend.
      return false
    }
  })
  return out
}

const files = uniqueRepoFiles(root, PATTERNS)
const all = files.flatMap(file => findViolations(file.abs))
const checked = files.length

if (all.length === 0) {
  console.log(`verify-md-wrap: ${checked} file(s) checked, no hard-wrapped prose paragraphs.`)
  process.exit(0)
}

console.error('verify-md-wrap: hard-wrapped prose paragraphs found (write one physical line per paragraph):')
for (const v of all) {
  console.error(`  ${v.file}:${v.line}  ${v.text.slice(0, 80)}${v.text.length > 80 ? '…' : ''}`)
}
process.exit(1)
