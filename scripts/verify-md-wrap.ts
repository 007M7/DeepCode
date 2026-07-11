/**
 * Reject Markdown prose paragraphs spanning multiple physical lines. The GFM
 * AST distinguishes paragraphs from multiline structural nodes; symlinked
 * instruction files are deduped.
 */

import { globSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes } from 'mdast'

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
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const out: Violation[] = []

  const visit = (node: Nodes): void => {
    if (node.type === 'paragraph' && node.position) {
      const { start, end } = node.position
      if (end.line > start.line) {
        const firstLine = source.split('\n')[start.line - 1] ?? ''
        out.push({ file, line: start.line, text: firstLine.trim() })
      }
      // Paragraph children are inline, so no further paragraph can be nested.
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
  for (const match of globSync(pattern, { cwd: root })) {
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
