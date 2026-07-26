/**
 * Pure assembly of the minimal-update briefing for one out-of-sync
 * translation pair: the authored side's diff since the last confirmed
 * state, the counterpart sections that diff lands in, the terminology rows
 * the diff touches, and a digest of the binding update rules. The CLI
 * wrapper is `scripts/gen-translation-brief.ts`; the workflow that consumes
 * the briefing is `.agents/skills/dsh-translate-docs/SKILL.md`.
 */

import type { Nodes } from 'mdast'
import { parseTranslationMarkdown } from './translation-pairing.ts'

/** One hunk of a unified diff, in old-side line coordinates. */
export interface DiffHunk {
  /** First old-side line the hunk touches (0 for an insertion at the top). */
  start: number
  /** Old-side line count (0 for a pure insertion). */
  count: number
}

/**
 * Parse the `@@ -start,count +… @@` hunk headers of a unified diff.
 *
 * @param diff - Unified diff text.
 * @returns Hunks in old-side coordinates, in order of appearance.
 */
export function parseUnifiedDiffHunks(diff: string): DiffHunk[] {
  const hunks: DiffHunk[] = []
  for (const line of diff.split('\n')) {
    const match = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line)
    if (match?.[1] === undefined) continue
    hunks.push({ start: Number(match[1]), count: match[2] === undefined ? 1 : Number(match[2]) })
  }
  return hunks
}

/**
 * Extract the added and removed content lines of a unified diff.
 *
 * @param diff - Unified diff text.
 * @returns The changed lines joined by newlines, diff markers stripped.
 */
export function changedLinesOfDiff(diff: string): string {
  const out: string[] = []
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) continue
    if (line.startsWith('+') || line.startsWith('-')) out.push(line.slice(1))
  }
  return out.join('\n')
}

/** One heading of a Markdown document, in document order. */
export interface HeadingSection {
  /** 1-based source line the heading starts on. */
  line: number
  /** Heading depth (`##` is 2). */
  depth: number
  /** Concatenated plain text of the heading. */
  label: string
}

/**
 * List a document's headings with their start lines via the pairing-gate parser.
 *
 * @param markdown - Document text.
 * @returns Headings in document order.
 */
export function headingSections(markdown: string): HeadingSection[] {
  const out: HeadingSection[] = []
  const visit = (node: Nodes): void => {
    if (node.type === 'heading') {
      let label = ''
      const collect = (child: Nodes): void => {
        if ('value' in child && typeof child.value === 'string') label += child.value
        if ('children' in child) for (const grandchild of child.children) collect(grandchild)
      }
      for (const child of node.children) collect(child)
      out.push({ line: node.position?.start.line ?? 1, depth: node.depth, label })
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(parseTranslationMarkdown(markdown))
  return out
}

/** Section index containing a 1-based line: 0 is the preamble before the first heading, i is the i-th heading's section. */
function sectionOf(line: number, headings: HeadingSection[]): number {
  let section = 0
  for (let index = 0; index < headings.length; index++) {
    const heading = headings[index]
    if (heading !== undefined && heading.line <= line) section = index + 1
  }
  return section
}

/**
 * Map diff hunks to the section indices they touch in the diffed document.
 *
 * @param hunks - Hunks in the diffed document's old-side coordinates.
 * @param headings - The diffed document's headings at that same old state.
 * @returns Ascending section indices (0 = preamble).
 */
export function mapHunksToSections(hunks: DiffHunk[], headings: HeadingSection[]): number[] {
  const sections = new Set<number>()
  for (const hunk of hunks) {
    const first = sectionOf(Math.max(hunk.start, 1), headings)
    const last = sectionOf(Math.max(hunk.start + Math.max(hunk.count - 1, 0), 1), headings)
    for (let section = first; section <= last; section++) sections.add(section)
  }
  return [...sections].sort((a, b) => a - b)
}

/** One counterpart section to update, with its current location. */
export interface CounterpartSection {
  /** Heading label, or the preamble marker for section 0. */
  label: string
  /** 1-based line the section starts on in the counterpart file. */
  startLine: number
  /** Current section text, trailing blank lines trimmed. */
  text: string
}

/**
 * Extract the counterpart's text for the given section indices.
 *
 * Callers must only pass indices produced against a structurally aligned
 * pair (same heading count and order), which the pairing gate guarantees
 * for a recorded-consistent state.
 *
 * @param counterpart - Current counterpart document text.
 * @param sections - Ascending section indices (0 = preamble).
 * @returns One entry per requested section.
 */
export function extractCounterpartSections(counterpart: string, sections: number[]): CounterpartSection[] {
  const headings = headingSections(counterpart)
  const lines = counterpart.split('\n')
  return sections.map((section) => {
    const heading = section === 0 ? undefined : headings[section - 1]
    const startLine = heading?.line ?? 1
    const nextHeading = headings[section]
    const endLine = nextHeading === undefined ? lines.length : nextHeading.line - 1
    const body = lines.slice(startLine - 1, endLine)
    while (body.length > 0 && body.at(-1) === '') body.pop()
    return {
      label: heading === undefined ? '(preamble before the first heading)' : `${'#'.repeat(heading.depth)} ${heading.label}`,
      startLine,
      text: body.join('\n'),
    }
  })
}

/** Terminology rows relevant to one diff, grouped under their table header. */
export interface TerminologyMatches {
  /** The matched rows' shared header row, or undefined when no row matched. */
  header?: string | undefined
  /** Matched data rows, verbatim, in table order. */
  rows: string[]
}

/** Strip Markdown emphasis and code markers from a terminology cell. */
function plainTerm(cell: string): string {
  return cell.replaceAll('`', '').replaceAll('**', '').trim()
}

/**
 * Select the terminology rows whose English or Chinese term occurs in the diff.
 *
 * English terms match case-insensitively on non-alphanumeric boundaries;
 * Chinese terms match by substring.
 *
 * @param terminology - Full `docs/i18n/terminology.md` contents.
 * @param changedText - Changed diff lines (see {@link changedLinesOfDiff}).
 * @returns Matched rows under their header.
 */
export function matchTerminologyRows(terminology: string, changedText: string): TerminologyMatches {
  const matches: TerminologyMatches = { rows: [] }
  let header: string | undefined
  for (const line of terminology.split('\n')) {
    if (!line.startsWith('|')) continue
    if (/^\|[\s:|-]+\|$/.test(line)) continue
    const cells = line.split('|').map(cell => cell.trim())
    if (line.includes('English') && line.includes('中文')) {
      header = line
      continue
    }
    const english = plainTerm(cells[1] ?? '')
    const chinese = plainTerm(cells[2] ?? '')
    const escaped = english.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const englishHit = english.length > 1 && new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'i').test(changedText)
    const chineseHit = /[一-鿿]/.test(chinese) && changedText.includes(chinese)
    if (englishHit || chineseHit) {
      matches.header ??= header
      matches.rows.push(line)
    }
  }
  return matches
}

/** Smallest fence of `mark` characters that safely wraps `body`. */
function fenceFor(body: string, mark: '`' | '~'): string {
  let longest = 2
  for (const line of body.split('\n')) {
    const run = new RegExp(`^\\s*(${mark === '`' ? '`' : '~'}{3,})`).exec(line)
    if (run?.[1] !== undefined && run[1].length > longest) longest = run[1].length
  }
  return mark.repeat(longest + 1)
}

/** The two update directions a pair supports. */
export type BriefDirection = 'en-to-zh' | 'zh-to-en'

/** Inputs for rendering one pair's briefing. */
export interface TranslationBriefInput {
  /** Repo-relative path of the side that changed. */
  sourcePath: string
  /** Repo-relative path of the counterpart to update. */
  counterpartPath: string
  direction: BriefDirection
  /** Unified diff of the changed side, last-confirmed to current. */
  diff: string
  /** Counterpart sections the diff maps to, or undefined when alignment is untrusted. */
  counterpartSections?: CounterpartSection[] | undefined
  /** Whether both sides drifted since the last confirmed state. */
  bothDrifted: boolean
  terminology: TerminologyMatches
}

const ZH_TARGET_DIGEST = [
  '- Edit ONLY what the diff requires; preserve the reviewed phrasing of everything unchanged.',
  '- Nothing added, nothing dropped: the Chinese must state exactly what the new English states.',
  '- Write natural institutional technical Chinese, not word-by-word gloss; terse stays terse.',
  '- Code fences byte-identical to the English side, comments included; inline code spans verbatim.',
  '- Relative links keep the `.md` target; only the switcher line links `.zh.md`.',
  '- Structure mirrors the counterpart: heading depths and order, list kinds and item counts, table rows and columns.',
  '- Typography: one half-width space between Chinese and Latin or digits; full-width punctuation in Chinese prose; 顿号 for enumerations; second person is 你.',
  '- One physical line per paragraph; exactly one trailing newline.',
]

const EN_TARGET_DIGEST = [
  '- Edit ONLY what the diff requires; preserve the reviewed phrasing of everything unchanged.',
  '- Nothing added, nothing dropped: the English must state exactly what the new Chinese states.',
  '- Write concise professional developer prose, not word-by-word gloss; terse stays terse.',
  '- Code fences byte-identical to the Chinese side, comments included; inline code spans verbatim.',
  '- Relative links keep the `.md` target; only the switcher line links `.zh.md`.',
  '- Structure mirrors the counterpart: heading depths and order, list kinds and item counts, table rows and columns.',
  '- One physical line per paragraph; exactly one trailing newline.',
]

/**
 * Render the complete briefing for one out-of-sync pair.
 *
 * @param input - Diff, mapped sections, terminology, and pair identity.
 * @returns Markdown briefing text.
 */
export function renderTranslationBrief(input: TranslationBriefInput): string {
  const sourceLanguage = input.direction === 'en-to-zh' ? 'English' : 'Chinese'
  const counterpartLanguage = input.direction === 'en-to-zh' ? 'Chinese' : 'English'
  const out: string[] = []
  out.push(`# Translation update briefing: ${input.sourcePath}`)
  out.push('')
  out.push(input.bothDrifted
    ? `WARNING: BOTH sides changed since the pair was last confirmed consistent. Reconcile the two sides by hand — decide which side owns each divergence per docs/i18n/translation-rules.md — before recording. The diff below covers the ${sourceLanguage} side only.`
    : `The ${sourceLanguage} side changed; bring \`${input.counterpartPath}\` along with the smallest edit that covers the diff. The ${counterpartLanguage} side is untouched since the pair was last confirmed consistent.`)
  out.push('')
  out.push(`## ${sourceLanguage} diff (last-confirmed → current)`)
  out.push('')
  const diffFence = fenceFor(input.diff, '`')
  out.push(`${diffFence}diff`)
  out.push(input.diff.trimEnd())
  out.push(diffFence)
  if (input.counterpartSections !== undefined) {
    out.push('')
    out.push(`## ${counterpartLanguage} text to update (aligned sections, current line numbers)`)
    for (const section of input.counterpartSections) {
      out.push('')
      out.push(`### ${section.label} — ${input.counterpartPath}:${section.startLine}`)
      out.push('')
      const fence = fenceFor(section.text, '~')
      out.push(`${fence}markdown`)
      out.push(section.text)
      out.push(fence)
    }
  } else {
    out.push('')
    out.push(`Counterpart sections are not shown: the pair's heading structures do not align at the compared states, so open \`${input.counterpartPath}\` directly and locate the regions yourself.`)
  }
  if (input.terminology.rows.length > 0 && input.terminology.header !== undefined) {
    out.push('')
    out.push('## Binding terminology rows matching this diff (docs/i18n/terminology.md)')
    out.push('')
    out.push(input.terminology.header)
    out.push(`|${' --- |'.repeat(Math.max(input.terminology.header.split('|').length - 2, 1))}`)
    for (const row of input.terminology.rows) out.push(row)
    out.push('')
    out.push('For any term you introduce that is not listed above, consult the full table before inventing a rendering.')
  }
  out.push('')
  out.push('## Rules digest (full rules: docs/i18n/translation-rules.md)')
  out.push('')
  out.push(...(input.direction === 'en-to-zh' ? ZH_TARGET_DIGEST : EN_TARGET_DIGEST))
  out.push('')
  out.push('## Finish')
  out.push('')
  out.push('1. Apply the smallest counterpart edit that covers the diff, then verify the changed hunks clause by clause against the source.')
  out.push(`2. \`pnpm run verify-translation-pairing --write ${input.sourcePath.replace(/\.zh\.md$/, '.md')}\``)
  out.push(`3. \`pnpm run verify-translation-pairing ${input.sourcePath.replace(/\.zh\.md$/, '.md')}\``)
  out.push('')
  return out.join('\n')
}
