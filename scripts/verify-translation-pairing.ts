/**
 * Enforce complete English/Chinese pairs, matching structure, and recorded git
 * blob hashes under the bilingual manifest. Required files and date-named docs
 * at or after `requiredSince` must be paired; excluded docs may have neither a
 * counterpart nor sidecar. `--list` reports state and `--write` records both
 * sides after human review. Translation quality remains a review responsibility.
 * See `docs/i18n/README.md` for the owning contract.
 */

import { createHash } from 'node:crypto'
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve, sep } from 'node:path'
import {
  datedDocumentDate,
  linksTo,
  parseTranslationMarkdown,
  parseTranslationPairingManifest,
  requiresPairByDate,
  translationStructureDiff,
  translationStructureSignature,
} from './translation-pairing.ts'

const root = resolve(import.meta.dirname, '..')
const listMode = process.argv.includes('--list')
const writeMode = process.argv.includes('--write')

/** Scope of the bilingual contract: root docs, Agent Notes, the docs tree, and the Python SDK tree. */
const SCOPE_PATTERNS = [
  'README.md',
  'README.zh.md',
  'README.i18n.yaml',
  '.agents/notes/**/*.md',
  '.agents/notes/**/*.i18n.yaml',
  'docs/**/*.md',
  'docs/**/*.i18n.yaml',
  'python/**/*.md',
  'python/**/*.i18n.yaml',
]

const manifest = parseTranslationPairingManifest(readFileSync(join(root, 'scripts/translation-pairing.manifest.json'), 'utf8'))

/**
 * An excluded entry ending in `/` excludes the whole directory. The trailing
 * slash IS the path boundary — `docs/tool-catalog/` cannot prefix-match a
 * sibling like `docs/tool-catalog-notes/x.md` — so directory entries in the
 * manifest must keep their trailing slash.
 */
function isExcluded(file: string): boolean {
  return manifest.excluded.some(entry => (entry.endsWith('/') ? file.startsWith(entry) : file === entry))
}

/** Full git blob hash (what `git hash-object` prints). */
function blobHash(content: Buffer): string {
  const hash = createHash('sha1')
  hash.update(`blob ${content.byteLength}\0`)
  hash.update(content)
  return hash.digest('hex')
}

/** The three paths of a pair, derived from the English-file path. */
function pairPaths(source: string): { zh: string; meta: string } {
  return { zh: source.replace(/\.md$/, '.zh.md'), meta: source.replace(/\.md$/, '.i18n.yaml') }
}

const META_LINE = /^([^:#]+\.md): ([0-9a-f]{40})$/

/** Parse a `foo.i18n.yaml` consistency record: basename → recorded blob hash. */
function parseMeta(content: string): Map<string, string> | undefined {
  const out = new Map<string, string>()
  for (const line of content.split('\n')) {
    if (line === '' || line.startsWith('#')) continue
    const match = META_LINE.exec(line)
    if (!match?.[1] || !match[2]) return undefined
    out.set(match[1], match[2])
  }
  return out
}

/** Render a `foo.i18n.yaml` consistency record. */
function renderMeta(source: string, sourceHash: string, zh: string, zhHash: string): string {
  return [
    '# Bilingual-pair consistency record (docs/i18n/README.md): the git blob hash of each',
    '# side as of the last confirmed-consistent state. Both languages carry equal authority;',
    '# after editing either side, bring the other along and re-record with:',
    '#   pnpm run verify-translation-pairing --write',
    `${basename(source)}: ${sourceHash}`,
    `${basename(zh)}: ${zhHash}`,
    '',
  ].join('\n')
}

// Enumerate the scope once.
const files = new Set<string>()
for (const pattern of SCOPE_PATTERNS) {
  for (const match of globSync(pattern, { cwd: root })) files.add(match.split(sep).join('/'))
}
const translations = [...files].filter(f => f.endsWith('.zh.md')).sort()
const metas = [...files].filter(f => f.endsWith('.i18n.yaml')).sort()
const sources = [...files].filter(f => f.endsWith('.md') && !f.endsWith('.zh.md')).sort()

// --write: (re)record both hashes for every complete pair, creating missing records.
if (writeMode) {
  let written = 0
  for (const source of sources) {
    if (isExcluded(source)) continue
    const { zh, meta } = pairPaths(source)
    if (!existsSync(join(root, zh))) continue
    const record = renderMeta(source, blobHash(readFileSync(join(root, source))), zh, blobHash(readFileSync(join(root, zh))))
    if (existsSync(join(root, meta)) && readFileSync(join(root, meta), 'utf8') === record) continue
    writeFileSync(join(root, meta), record)
    console.log(`verify-translation-pairing: recorded ${meta}`)
    written++
  }
  console.log(`verify-translation-pairing: ${written} record(s) written; run the check to validate the pairs.`)
  process.exit(0)
}

const errors: string[] = []
const state = new Map<string, 'ok' | 'out-of-sync' | 'missing'>()

// 1. Required pairs exist.
for (const req of manifest.required) {
  if (!existsSync(join(root, req))) {
    errors.push(`${req}: listed in translation-pairing.manifest.json \`required\` but the file does not exist`)
    continue
  }
  const { zh } = pairPaths(req)
  if (!existsSync(join(root, zh))) {
    errors.push(`${req}: required to have a translation, but ${zh} does not exist`)
    state.set(req, 'missing')
  }
}

// 2. Date-named documents (Agent Notes) dated on/after the requiredSince cutoff merge
// bilingual: a new Agent Note lands with its pair or not at all. Deterministic from
// the filename alone — no git history, so it holds on shallow CI checkouts.
for (const source of sources) {
  if (isExcluded(source)) continue
  const date = datedDocumentDate(source)
  if (!requiresPairByDate(source, manifest.requiredSince) || date === undefined) continue
  const { zh } = pairPaths(source)
  if (!existsSync(join(root, zh))) {
    errors.push(`${source}: dated ${date} — documents dated on/after ${manifest.requiredSince} merge bilingual (docs/i18n/README.md); add the counterpart and record the pair`)
    state.set(source, 'missing')
  }
}

// 3. Every pair that exists at all is complete and consistent. Anchor on the
// union of .zh.md files and .i18n.yaml records so a half-deleted pair is
// caught from either remnant.
const pairAnchors = new Set<string>()
for (const zh of translations) pairAnchors.add(zh.replace(/\.zh\.md$/, '.md'))
for (const meta of metas) pairAnchors.add(meta.replace(/\.i18n\.yaml$/, '.md'))

for (const source of [...pairAnchors].sort()) {
  const { zh, meta } = pairPaths(source)
  const have = { source: existsSync(join(root, source)), zh: existsSync(join(root, zh)), meta: existsSync(join(root, meta)) }

  if (isExcluded(source)) {
    if (have.zh) errors.push(`${zh}: ${source} is excluded from pairing (generated or bilingual-by-construction); this translation must not exist`)
    if (have.meta) errors.push(`${meta}: ${source} is excluded from pairing; this consistency record must not exist`)
    continue
  }
  const missing = Object.entries(have).filter(([, ok]) => !ok).map(([k]) => (k === 'source' ? source : k === 'zh' ? zh : meta))
  if (missing.length > 0) {
    errors.push(`${source}: incomplete pair — missing ${missing.join(', ')} (pairs merge whole: both languages plus the .i18n.yaml record)`)
    continue
  }

  const sourceContent = readFileSync(join(root, source))
  const zhContent = readFileSync(join(root, zh))
  const record = parseMeta(readFileSync(join(root, meta), 'utf8'))
  if (!record || record.size !== 2 || !record.has(basename(source)) || !record.has(basename(zh))) {
    errors.push(`${meta}: malformed consistency record (expected exactly \`${basename(source)}: <40-hex>\` and \`${basename(zh)}: <40-hex>\`)`)
    continue
  }

  let consistent = true
  for (const [file, content] of [[source, sourceContent], [zh, zhContent]] as const) {
    const current = blobHash(content)
    if (record.get(basename(file)) !== current) {
      errors.push(`${file}: out of sync — content no longer matches the pair's last confirmed-consistent state in ${meta} (bring the other side along, then re-record with --write)`)
      consistent = false
    }
  }
  if (!consistent) {
    state.set(source, 'out-of-sync')
    continue
  }

  const sourceTree = parseTranslationMarkdown(sourceContent.toString('utf8'))
  const zhTree = parseTranslationMarkdown(zhContent.toString('utf8'))
  if (!linksTo(zhTree, basename(source))) {
    errors.push(`${zh}: missing language switcher — no link to ${basename(source)}`)
  }
  if (!linksTo(sourceTree, basename(zh))) {
    errors.push(`${source}: missing language switcher — no link back to ${basename(zh)}`)
  }
  for (const divergence of translationStructureDiff(
    translationStructureSignature(sourceTree, basename(zh)),
    translationStructureSignature(zhTree, basename(source)),
  )) {
    errors.push(`${source} ↔ ${zh}: ${divergence}`)
  }
  if (!state.has(source)) state.set(source, 'ok')
}

// Complete the state map for --list: any in-scope, non-excluded document with no pair yet is backlog.
for (const source of sources) {
  if (!isExcluded(source) && !state.has(source)) state.set(source, 'missing')
}

if (listMode) {
  const order = { 'out-of-sync': 0, missing: 1, ok: 2 } as const
  const rows = [...state.entries()].sort((a, b) => order[a[1]] - order[b[1]] || a[0].localeCompare(b[0]))
  for (const [file, status] of rows) {
    const required = manifest.required.includes(file)
    const tag = required ? '  (required)' : requiresPairByDate(file, manifest.requiredSince) ? '  (required by date)' : '  (backlog)'
    console.log(`${status.padEnd(11)} ${file}${status === 'missing' ? tag : ''}`)
  }
  const counts = { 'ok': 0, 'out-of-sync': 0, 'missing': 0 }
  for (const status of state.values()) counts[status]++
  console.log(`verify-translation-pairing: ${counts.ok} ok, ${counts['out-of-sync']} out-of-sync, ${counts.missing} missing (of ${state.size} in scope)`)
  process.exit(0)
}

if (errors.length === 0) {
  console.log(`verify-translation-pairing: ${pairAnchors.size} pair(s) checked against ${manifest.required.length} required, all consistent.`)
  process.exit(0)
}

console.error('verify-translation-pairing: bilingual pairing contract violated (see docs/i18n/README.md):')
for (const message of errors) console.error(`  ${message}`)
process.exit(1)
