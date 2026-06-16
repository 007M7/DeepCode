/**
 * Doc-sync gate: enforce the repo's "Markdown is not hard-wrapped" convention
 * (AGENTS.md § Type Safety and Documentation) — prose paragraphs are written as
 * one physical line per paragraph and the editor soft-wraps. A hard-wrapped
 * paragraph (a one-word edit reflows and re-diffs the whole block) is a defect
 * this script catches before review.
 *
 * Scope mirrors doc-typecheck plus the two AGENTS.md files that doc-sync does
 * NOT otherwise cover (the convention itself lives there): README.md,
 * docs/** /*.md, packages/* /README.md, AGENTS.md, packages/AGENTS.md. (The
 * root and packages/ CLAUDE.md are symlinks to the AGENTS.md files, so they are
 * skipped to avoid double-reporting.)
 *
 * A violation is two consecutive *prose* lines — a paragraph that spans
 * physical lines instead of soft-wrapping. Structure that legitimately occupies
 * multiple lines is exempt: fenced code blocks, tables, list items (and their
 * indented continuations), headings, blockquotes, HTML blocks/comments,
 * horizontal rules, and reference-link / footnote definitions.
 *
 * Run: `tsx scripts/verify-md-wrap.ts`.
 */

import { readFileSync, realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'
import { glob } from 'node:fs/promises'

const root = resolve(import.meta.dirname, '..')

/** Files to check: doc-typecheck's scope plus the AGENTS.md pair. */
const PATTERNS = ['README.md', 'docs/**/*.md', 'packages/*/README.md', 'AGENTS.md', 'packages/AGENTS.md']

/** A located hard-wrap: the second line of a multi-line prose paragraph. */
interface Violation {
  file: string
  /** 1-based line number of the offending continuation line. */
  line: number
  text: string
}

/**
 * True when a line is *prose* — ordinary paragraph text, not markdown
 * structure. Structural lines (headings, lists, tables, blockquotes, HTML,
 * fences, hrs, reference defs) legitimately stand alone or stack, so they never
 * count toward a hard-wrap pair. Caller handles fenced-code and list-body state.
 */
function isProse(line: string): boolean {
  if (line.trim() === '') return false
  // Up to 3 leading spaces is still a "top-level" block in CommonMark; deeper
  // indentation is handled as list continuation by the caller.
  const s = line.replace(/^ {0,3}/, '')
  if (/^#{1,6}\s/.test(s)) return false // ATX heading
  if (/^([-*+])\s/.test(s)) return false // bullet list
  if (/^\d{1,9}[.)]\s/.test(s)) return false // ordered list
  if (/^>/.test(s)) return false // blockquote
  if (/^\|/.test(s)) return false // table row
  if (/^<!--/.test(s) || /-->\s*$/.test(s)) return false // HTML comment line
  if (/^</.test(s)) return false // HTML block line
  if (/^([-*_])( *\1){2,}\s*$/.test(s)) return false // thematic break (hr)
  if (/^\[[^\]]+\]:\s/.test(s)) return false // reference-link / footnote definition
  if (/^[=-]+\s*$/.test(s)) return false // setext heading underline
  return true
}

/** Find every hard-wrapped prose paragraph in one Markdown file. */
function findViolations(absPath: string): Violation[] {
  const file = relative(root, absPath)
  const lines = readFileSync(absPath, 'utf8').split('\n')
  const out: Violation[] = []

  let inFence = false
  let fenceMarker = '' // '```' or '~~~'
  let inComment = false // inside a multi-line <!-- … --> HTML comment
  let inListItem = false // inside a list item's body (its indented continuations)
  let prevWasProse = false

  lines.forEach((raw, i) => {
    const trimmed = raw.trim()

    // Fenced code blocks: everything between matching fences is exempt.
    const fence = /^ {0,3}(```+|~~~+)/.exec(raw)
    if (fence) {
      const marker = (fence[1] ?? '').startsWith('`') ? '```' : '~~~'
      if (!inFence) {
        inFence = true
        fenceMarker = marker
      } else if (marker === fenceMarker) {
        inFence = false
      }
      prevWasProse = false
      return
    }
    if (inFence) {
      prevWasProse = false
      return
    }

    // Multi-line HTML comments are exempt (e.g. generated-file headers). Track
    // open/close across lines so the body of a 3+ line comment isn't read as
    // hard-wrapped prose.
    if (inComment) {
      if (/-->/.test(raw)) inComment = false
      prevWasProse = false
      return
    }
    if (/^ {0,3}<!--/.test(raw) && !/-->/.test(raw)) {
      inComment = true
      prevWasProse = false
      return
    }

    if (trimmed === '') {
      inListItem = false
      prevWasProse = false
      return
    }

    // Track list context so an item's wrapped continuation lines (indented or
    // lazy) are treated as list structure, not a hard-wrapped prose paragraph.
    const isListMarker = /^ {0,3}([-*+]|\d{1,9}[.)])\s/.test(raw)
    if (isListMarker) {
      inListItem = true
      prevWasProse = false
      return
    }
    if (inListItem) {
      // Indented under the item, or lazy continuation — still the list item.
      prevWasProse = false
      return
    }

    if (!isProse(raw)) {
      prevWasProse = false
      return
    }

    // A prose line. If the line before it was also prose, the paragraph spans
    // physical lines — a hard wrap.
    if (prevWasProse) {
      out.push({ file, line: i + 1, text: trimmed })
    }
    prevWasProse = true
  })

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
