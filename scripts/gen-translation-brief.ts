/**
 * Print the minimal-update briefing for out-of-sync translation pairs:
 * `pnpm run gen-translation-brief [pair paths...]`. With no arguments it
 * discovers every out-of-sync pair; with arguments (any file of a pair) it
 * briefs exactly those pairs and fails loud on in-sync, incomplete, or
 * out-of-scope requests. The briefing contract lives in
 * `scripts/translation-brief.ts`; the consuming workflow is
 * `.agents/skills/dsh-translate-docs/SKILL.md`.
 */

import { spawnSync } from 'node:child_process'
import { existsSync, globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import {
  isTranslationScopeFile,
  pairAnchorOfArgument,
  parseTranslationPairingManifest,
  TRANSLATION_SCOPE_GLOB_EXCLUDES,
} from './translation-pairing.ts'
import {
  changedLinesOfDiff,
  extractCounterpartSections,
  headingSections,
  mapHunksToSections,
  matchTerminologyRows,
  parseUnifiedDiffHunks,
  renderTranslationBrief,
  type BriefDirection,
  type CounterpartSection,
} from './translation-brief.ts'

const root = resolve(import.meta.dirname, '..')
const manifest = parseTranslationPairingManifest(readFileSync(join(root, 'scripts/translation-pairing.manifest.json'), 'utf8'))
const terminology = readFileSync(join(root, 'docs/i18n/terminology.md'), 'utf8')

function isExcluded(file: string): boolean {
  return manifest.excluded.some(entry => (entry.endsWith('/') ? file.startsWith(entry) : file === entry))
}

/** Recorded hashes of one consistency record: basename → blob hash. */
function parseMeta(content: string): Map<string, string> | undefined {
  const out = new Map<string, string>()
  for (const line of content.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const match = /^([^:#]+\.md): ([0-9a-f]{40})$/.exec(line)
    if (!match?.[1] || !match[2]) return undefined
    out.set(match[1], match[2])
  }
  return out
}

function git(args: string[], allowedExitCodes: number[] = [0]): string {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', maxBuffer: 1 << 26 })
  if (result.error) throw result.error
  if (!allowedExitCodes.includes(result.status ?? -1)) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

function blobText(hash: string): string {
  return git(['cat-file', '-p', hash])
}

/** Unified diff between two texts, headers stripped, via `git diff --no-index`. */
function diffTexts(before: string, after: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'translation-brief-'))
  try {
    writeFileSync(join(dir, 'last-confirmed.md'), before)
    writeFileSync(join(dir, 'current.md'), after)
    const raw = git(['diff', '--no-index', '--unified=2', join(dir, 'last-confirmed.md'), join(dir, 'current.md')], [0, 1])
    return raw.split('\n')
      .filter(line => !line.startsWith('diff --git') && !line.startsWith('index ') && !line.startsWith('--- ') && !line.startsWith('+++ '))
      .join('\n')
      .trim()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

interface PairState {
  anchor: string
  zh: string
  meta: string
  enDrifted: boolean
  zhDrifted: boolean
  enLast: string
  zhLast: string
}

/** Load one pair's recorded and current state, or explain why it cannot be briefed. */
function loadPair(anchor: string): PairState | string {
  const zh = anchor.replace(/\.md$/, '.zh.md')
  const meta = anchor.replace(/\.md$/, '.i18n.yaml')
  if (!isTranslationScopeFile(anchor) || isExcluded(anchor)) {
    return `${anchor}: not an in-scope documentation pair (docs/i18n/README.md)`
  }
  const missing = [anchor, zh, meta].filter(file => !existsSync(join(root, file)))
  if (missing.length > 0) {
    return `${anchor}: incomplete pair (missing ${missing.join(', ')}) — a new counterpart is whole-document translation work, not a minimal update`
  }
  const record = parseMeta(readFileSync(join(root, meta), 'utf8'))
  const enRecorded = record?.get(basename(anchor))
  const zhRecorded = record?.get(basename(zh))
  if (record === undefined || enRecorded === undefined || zhRecorded === undefined) {
    return `${meta}: malformed consistency record`
  }
  const enCurrent = readFileSync(join(root, anchor), 'utf8')
  const zhCurrent = readFileSync(join(root, zh), 'utf8')
  const enLast = blobText(enRecorded)
  const zhLast = blobText(zhRecorded)
  return {
    anchor,
    zh,
    meta,
    enDrifted: enCurrent !== enLast,
    zhDrifted: zhCurrent !== zhLast,
    enLast,
    zhLast,
  }
}

/** Whether two documents' heading sequences align one to one. */
function headingsAligned(a: string, b: string): boolean {
  const aHeads = headingSections(a)
  const bHeads = headingSections(b)
  return aHeads.length === bHeads.length && aHeads.every((heading, index) => heading.depth === bHeads[index]?.depth)
}

/** Render the briefing for one drifted side of a pair. */
function briefDirection(pair: PairState, direction: BriefDirection): string {
  const sourceIsEnglish = direction === 'en-to-zh'
  const sourcePath = sourceIsEnglish ? pair.anchor : pair.zh
  const counterpartPath = sourceIsEnglish ? pair.zh : pair.anchor
  const sourceLast = sourceIsEnglish ? pair.enLast : pair.zhLast
  const sourceCurrent = readFileSync(join(root, sourcePath), 'utf8')
  const counterpartCurrent = readFileSync(join(root, counterpartPath), 'utf8')
  const diff = diffTexts(sourceLast, sourceCurrent)
  const bothDrifted = pair.enDrifted && pair.zhDrifted

  let counterpartSections: CounterpartSection[] | undefined
  if (!bothDrifted && headingsAligned(sourceLast, counterpartCurrent)) {
    const sections = mapHunksToSections(parseUnifiedDiffHunks(diff), headingSections(sourceLast))
    counterpartSections = extractCounterpartSections(counterpartCurrent, sections)
  }
  return renderTranslationBrief({
    sourcePath,
    counterpartPath,
    direction,
    diff,
    counterpartSections,
    bothDrifted,
    terminology: matchTerminologyRows(terminology, changedLinesOfDiff(diff)),
  })
}

const requested = process.argv.slice(2).map(pairAnchorOfArgument)

let anchors: string[]
if (requested.length > 0) {
  anchors = [...new Set(requested)].sort()
} else {
  const discovered = new Set<string>()
  for (const match of globSync('**/*.i18n.yaml', { cwd: root, exclude: TRANSLATION_SCOPE_GLOB_EXCLUDES })) {
    const normalized = match.split(sep).join('/')
    if (isTranslationScopeFile(normalized)) discovered.add(normalized.replace(/\.i18n\.yaml$/, '.md'))
  }
  anchors = [...discovered].sort()
}

const briefs: string[] = []
const problems: string[] = []
const skipped: string[] = []
for (const anchor of anchors) {
  const pair = loadPair(anchor)
  if (typeof pair === 'string') {
    if (requested.length > 0) problems.push(pair)
    continue
  }
  if (!pair.enDrifted && !pair.zhDrifted) {
    if (requested.length > 0) skipped.push(`${anchor}: pair is consistent with its record — nothing to brief`)
    continue
  }
  if (pair.enDrifted) briefs.push(briefDirection(pair, 'en-to-zh'))
  if (pair.zhDrifted) briefs.push(briefDirection(pair, 'zh-to-en'))
}

if (problems.length > 0 || skipped.length > 0) {
  for (const message of [...problems, ...skipped]) console.error(`gen-translation-brief: ${message}`)
  process.exit(2)
}
if (briefs.length === 0) {
  console.log('gen-translation-brief: every recorded pair matches its consistency record; nothing to brief.')
  process.exit(0)
}
console.log(briefs.join('\n\n---\n\n'))
