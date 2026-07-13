/**
 * Doc-sync gate: require every workspace package README to explain its exact
 * model-visible context surface and token behavior. Most packages require the
 * canonical context-surface blocks plus an optional linked long-literal
 * appendix; an audited allowlist requires one concise zero-effect or
 * indirect-only sentence instead.
 *
 * Run: `tsx scripts/verify-package-readme-model-experience.ts`.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const HEADING = '## Model Experience'
const LIMITATIONS_HEADING = '## Known Limitations and Deferred Work'
const VERBATIM_HEADING = '### Verbatim model-visible text'
const MODEL_VIEW_LABEL = '**What the model sees**'
const TOKEN_EFFECT_LABEL = '**Token effect**'
const H2_HEADING = /^## .+$/

type SentenceKind = 'none' | 'indirect'

interface SentenceContract {
  kind: SentenceKind
  reason: string
}

/**
 * Packages whose Model Experience is simple enough for one gated sentence.
 * Every other package must carry canonical context-surface blocks. A package
 * moves on or off this list with the change to its context behavior.
 */
const SENTENCE_MODEL_EXPERIENCE: Readonly<Record<string, SentenceContract>> = {
  'packages/bash/bash': { kind: 'indirect', reason: 'The service interface delegates all model rendering to dsh-tool-bash.' },
  'packages/code-runtime/code-runtime': { kind: 'indirect', reason: 'The service interface delegates model rendering to Code Mode in dsh-tools.' },
  'packages/fs/fs': { kind: 'indirect', reason: 'The service interface delegates model rendering to dsh-tool-fs.' },
  'packages/hooks/hook-protocol': { kind: 'indirect', reason: 'Only the hook bridge plugins render decoded hook output to a model.' },
  'packages/skill/skill': { kind: 'indirect', reason: 'The provider registry delegates model rendering to dsh-tool-skill.' },
  'packages/subagent/subagent-subprocess': { kind: 'indirect', reason: 'Only process-based subagent backends compose a child model request.' },
  'packages/support/acp-snapshot': { kind: 'none', reason: 'The test harness observes and normalizes transcripts without changing live requests.' },
  'packages/support/invariants': { kind: 'none', reason: 'The observer validates requests but never rewrites their context.' },
  'packages/ui/app-boot': { kind: 'indirect', reason: 'Only the loaded plugin tree contributes model context.' },
  'packages/util/brand': { kind: 'none', reason: 'The type-only primitive is erased at compile time.' },
  'packages/util/timeout': { kind: 'indirect', reason: 'Only timeout consumers render timeout outcomes.' },
  'packages/workflow/workflow': { kind: 'indirect', reason: 'The service delegates parent and child model rendering to its consumer and engine.' },
}

interface Failure {
  path: string
  message: string
}

interface Line {
  index: number
  raw: string
}

/** Split Markdown into prose lines, excluding fenced code that may quote the contract. */
function proseLines(text: string): Line[] {
  let fence: { marker: '`' | '~'; length: number } | undefined
  const kept: Line[] = []
  text.split('\n').forEach((raw, i) => {
    const token = /^ {0,3}(`{3,}|~{3,})/.exec(raw)?.[1]
    if (token !== undefined) {
      const marker = token[0] as '`' | '~'
      if (fence === undefined) {
        fence = { marker, length: token.length }
      } else if (marker === fence.marker && token.length >= fence.length) {
        fence = undefined
      }
      return
    }
    if (fence === undefined) kept.push({ index: i + 1, raw })
  })
  return kept
}

/** Validate the optional long-form literal appendix after the context blocks. */
function validateVerbatimTail(raw: readonly string[]): { blocks: number; titles: string[]; error?: string } {
  let cursor = 0
  while (raw[cursor]?.trim().length === 0) cursor += 1
  if (cursor === raw.length) return { blocks: 0, titles: [] }
  if (raw[cursor] !== VERBATIM_HEADING) {
    return { blocks: 0, titles: [], error: `content after the context surfaces must begin with ${VERBATIM_HEADING}` }
  }
  cursor += 1

  let blocks = 0
  const titles: string[] = []
  while (true) {
    while (raw[cursor]?.trim().length === 0) cursor += 1
    if (cursor === raw.length) break
    if (!/^#### \S/.test(raw[cursor] ?? '')) {
      return { blocks, titles, error: `${VERBATIM_HEADING} entries require a non-empty H4 title` }
    }
    const title = (raw[cursor] as string).slice('#### '.length)
    const fragment = headingFragment(title)
    if (fragment.length === 0) return { blocks, titles, error: 'verbatim H4 title must produce a non-empty link fragment' }
    if (titles.some(existing => headingFragment(existing) === fragment)) {
      return { blocks, titles, error: `verbatim H4 link fragment ${JSON.stringify(fragment)} is duplicated` }
    }
    titles.push(title)
    cursor += 1
    while (raw[cursor]?.trim().length === 0) cursor += 1
    if (raw[cursor] !== '```markdown') {
      return { blocks, titles, error: 'each verbatim entry requires an exact ```markdown fence' }
    }
    cursor += 1
    const contentStart = cursor
    while (cursor < raw.length && raw[cursor] !== '```') cursor += 1
    if (cursor === raw.length) return { blocks, titles, error: 'unterminated verbatim ```markdown fence' }
    if (cursor === contentStart) return { blocks, titles, error: 'verbatim ```markdown fence must not be empty' }
    cursor += 1
    blocks += 1
  }
  return blocks > 0 ? { blocks, titles } : { blocks, titles, error: `${VERBATIM_HEADING} requires at least one entry` }
}

/** GitHub-style fragment for the simple ASCII H4 titles allowed by this contract. */
function headingFragment(title: string): string {
  return title.toLowerCase().replaceAll('`', '').replaceAll(/[^a-z0-9 _-]/g, '').trim().replaceAll(/\s+/g, '-')
}

const failures: Failure[] = []
const packageJsons = globSync('packages/*/*/package.json', { cwd: root }).sort()
const scannedPackages = new Set(packageJsons.map(path => path.slice(0, -'/package.json'.length)))
let structuredCount = 0
let contextSurfaceCount = 0
let noneCount = 0
let indirectCount = 0
let verbatimBlockCount = 0

for (const [pkg, contract] of Object.entries(SENTENCE_MODEL_EXPERIENCE)) {
  if (!scannedPackages.has(pkg)) {
    failures.push({ path: `${pkg}/README.md`, message: 'sentence allowlist entry does not name a scanned package' })
  }
  if (contract.reason.trim().length === 0) {
    failures.push({ path: `${pkg}/README.md`, message: 'sentence allowlist entry must justify why structured context surfaces are unnecessary' })
  }
}

for (const packageJson of packageJsons) {
  const pkg = packageJson.slice(0, -'/package.json'.length)
  const readme = packageJson.replace(/package\.json$/, 'README.md')
  const abs = resolve(root, readme)
  if (!existsSync(abs)) {
    failures.push({ path: readme, message: `missing package README; add one with ${HEADING}` })
    continue
  }

  const text = readFileSync(abs, 'utf8')
  const rawLines = text.split('\n')
  const lines = proseLines(text)
  const h2Headings = lines.filter(line => H2_HEADING.test(line.raw))
  const modelHeadings = h2Headings.filter(line => line.raw === HEADING)
  if (modelHeadings.length !== 1) {
    failures.push({
      path: readme,
      message: modelHeadings.length === 0 ? `missing ${HEADING}` : `contains ${modelHeadings.length} copies of ${HEADING}`,
    })
    continue
  }

  const modelHeading = modelHeadings[0] as Line
  const modelH2Index = h2Headings.indexOf(modelHeading)
  const limitationsH2Index = h2Headings.findIndex(heading => heading.raw === LIMITATIONS_HEADING)
  if (limitationsH2Index >= 0) {
    if (modelH2Index !== h2Headings.length - 2 || limitationsH2Index !== h2Headings.length - 1) {
      failures.push({
        path: readme,
        message: `${HEADING} and ${LIMITATIONS_HEADING} must be the final two H2 sections, in that order`,
      })
      continue
    }
  } else if (modelH2Index !== h2Headings.length - 1) {
    failures.push({ path: readme, message: `${HEADING} must be the final H2 when ${LIMITATIONS_HEADING} is absent` })
    continue
  }

  const body = lines.slice(lines.indexOf(modelHeading) + 1)
  const nextH2 = body.findIndex(line => H2_HEADING.test(line.raw))
  const section = nextH2 < 0 ? body : body.slice(0, nextH2)
  const nextH2Line = nextH2 < 0 ? rawLines.length + 1 : (body[nextH2] as Line).index
  const rawSection = rawLines.slice(modelHeading.index, nextH2Line - 1)
  const content = section.filter(line => line.raw.trim().length > 0)
  const sentenceContract = SENTENCE_MODEL_EXPERIENCE[pkg]
  if (sentenceContract !== undefined) {
    const pattern = sentenceContract.kind === 'none' ? /^None, as .+\.$/ : /^Indirectly, through .+\.$/
    const rawContent = rawSection.filter(line => line.trim().length > 0)
    if (content.length !== 1 || rawContent.length !== 1 || !pattern.test(content[0]?.raw ?? '')) {
      const prefix = sentenceContract.kind === 'none' ? 'None, as ' : 'Indirectly, through '
      failures.push({ path: readme, message: `must contain exactly one sentence beginning ${JSON.stringify(prefix)} and ending with a period` })
      continue
    }
    if (sentenceContract.kind === 'none') noneCount += 1
    else indirectCount += 1
    continue
  }

  const shortSentence = content.find(line => /^None, as |^Indirectly, through /.test(line.raw))
  if (shortSentence !== undefined) {
    failures.push({ path: readme, message: `line ${shortSentence.index}: short Model Experience form requires an audited entry in SENTENCE_MODEL_EXPERIENCE` })
    continue
  }

  const appendixIndex = content.findIndex(line => line.raw === VERBATIM_HEADING)
  const surfaceContent = appendixIndex < 0 ? content : content.slice(0, appendixIndex)
  if (surfaceContent.length === 0 || surfaceContent.length % 3 !== 0) {
    failures.push({ path: readme, message: 'must contain one or more complete context-surface blocks' })
    continue
  }

  const surfaces: Array<{ heading: Line; modelView: Line; tokenEffect: Line }> = []
  const surfaceFragments = new Set<string>()
  let previousTokenEffect: Line | undefined
  let surfaceError = false
  for (let index = 0; index < surfaceContent.length; index += 3) {
    const heading = surfaceContent[index] as Line
    const modelView = surfaceContent[index + 1] as Line
    const tokenEffect = surfaceContent[index + 2] as Line
    const fragment = /^### \S/.test(heading.raw) && heading.raw !== VERBATIM_HEADING
      ? headingFragment(heading.raw.slice('### '.length))
      : ''
    if (fragment.length === 0) {
      failures.push({ path: readme, message: `line ${heading.index}: each context surface requires a non-empty H3 heading` })
      surfaceError = true
      break
    }
    if (surfaceFragments.has(fragment)) {
      failures.push({ path: readme, message: `line ${heading.index}: duplicate context-surface link fragment ${JSON.stringify(fragment)}` })
      surfaceError = true
      break
    }
    if (!modelView.raw.startsWith(`${MODEL_VIEW_LABEL}: `) || modelView.raw.slice(`${MODEL_VIEW_LABEL}: `.length).trim().length === 0) {
      failures.push({ path: readme, message: `line ${modelView.index}: context surface requires non-empty ${MODEL_VIEW_LABEL}: text` })
      surfaceError = true
      break
    }
    if (!tokenEffect.raw.startsWith(`${TOKEN_EFFECT_LABEL}: `) || tokenEffect.raw.slice(`${TOKEN_EFFECT_LABEL}: `.length).trim().length === 0) {
      failures.push({ path: readme, message: `line ${tokenEffect.index}: context surface requires non-empty ${TOKEN_EFFECT_LABEL}: text` })
      surfaceError = true
      break
    }
    const expectedHeadingLine = previousTokenEffect?.index === undefined ? modelHeading.index + 2 : previousTokenEffect.index + 2
    if (heading.index !== expectedHeadingLine || modelView.index !== heading.index + 2 || tokenEffect.index !== modelView.index + 2) {
      failures.push({ path: readme, message: `line ${heading.index}: context-surface heading and fields require one blank line between each element` })
      surfaceError = true
      break
    }
    surfaceFragments.add(fragment)
    surfaces.push({ heading, modelView, tokenEffect })
    previousTokenEffect = tokenEffect
  }
  if (surfaceError) continue

  const lastSurface = surfaces.at(-1) as { heading: Line; modelView: Line; tokenEffect: Line }
  if (appendixIndex >= 0 && (content[appendixIndex] as Line).index !== lastSurface.tokenEffect.index + 2) {
    failures.push({ path: readme, message: `${VERBATIM_HEADING} must follow the final context surface after one blank line` })
    continue
  }

  const rawTail = rawLines.slice(lastSurface.tokenEffect.index, nextH2Line - 1)
  const verbatim = validateVerbatimTail(rawTail)
  if (verbatim.error !== undefined) {
    failures.push({ path: readme, message: verbatim.error })
    continue
  }
  const modelViewText = surfaces.map(surface => surface.modelView.raw).join('\n')
  const unlinked = verbatim.titles.find(title => !modelViewText.includes(`](#${headingFragment(title)})`))
  if (unlinked !== undefined) {
    failures.push({ path: readme, message: `verbatim entry ${JSON.stringify(unlinked)} must be linked from a context surface's ${MODEL_VIEW_LABEL} field` })
    continue
  }
  verbatimBlockCount += verbatim.blocks
  contextSurfaceCount += surfaces.length
  structuredCount += 1
}

if (failures.length === 0) {
  console.log(`verify-package-readme-model-experience: ${packageJsons.length} README(s) checked (${structuredCount} structured, ${contextSurfaceCount} context surfaces, ${noneCount} none, ${indirectCount} indirect, ${verbatimBlockCount} verbatim markdown blocks), all conform.`)
  process.exit(0)
}

console.error('verify-package-readme-model-experience failed:')
for (const failure of failures) {
  console.error(`  ${relative(root, resolve(root, failure.path))}: ${failure.message}`)
}
process.exit(1)
