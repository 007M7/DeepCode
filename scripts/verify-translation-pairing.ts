/**
 * Doc-sync gate: enforce the bilingual pairing contract (docs/i18n/README.md).
 * English and Chinese carry EQUAL authority — either language may be authored
 * first — so consistency is recorded per pair in a sidecar metadata file,
 * `foo.i18n.yaml`, holding the full git blob hash of BOTH files as of the last
 * time a human confirmed the two say the same thing:
 *
 *   foo.md: <40-hex blob hash>
 *   foo.zh.md: <40-hex blob hash>
 *
 * The gate checks, mechanically, the checkable half of the contract:
 *
 *   1. Every file in the manifest's `required` list has a COMPLETE pair
 *      (the enforcement frontier — grows batch by batch).
 *   2. Every pair that exists at all is complete and consistent: all three
 *      files present (a `.zh.md` or a `.i18n.yaml` without its counterparts
 *      is an error — pairs merge whole, never half), each side's current
 *      blob hash equals the recorded one (an edit to EITHER side without a
 *      re-confirmed counterpart goes red), both sides carry the language
 *      switcher, and the structural signatures match one to one — heading
 *      depths in order, fenced code blocks VERBATIM (info string + content),
 *      table column counts, list kinds, and every link target except the
 *      switcher itself.
 *   3. `excluded` files (generated docs, agent instructions, the bilingual
 *      terminology table) have no `.zh.md` and no `.i18n.yaml` at all.
 *
 * What it deliberately does NOT check is translation quality or which side
 * is "right": a green gate means the pair was confirmed consistent at these
 * exact contents, not that the confirmation was sound — accuracy,
 * terminology, and tone are the human reviewer's half of the contract
 * (docs/i18n/translation-rules.md).
 *
 * Blob hashes, not commit hashes, so a pair edited in the same PR verifies
 * without any history lookup: consistency is a pure content comparison,
 * computed here directly (sha1 of `blob <size>\0<content>`) without spawning
 * git. The recorded hash also recovers the last-confirmed text of either
 * side (`git cat-file -p <hash>`) for diff-based minimal updates.
 *
 * Run: `tsx scripts/verify-translation-pairing.ts` — or with `--list` to
 * print the pairing state of every in-scope document as a work list (always
 * exits 0), or with `--write` to (re)record both hashes for every complete
 * pair after you have brought the two sides back in line (the resulting
 * yaml diff is the reviewable act of confirming consistency).
 */

import { createHash } from 'node:crypto'
import { existsSync, globSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes } from 'mdast'

const root = resolve(import.meta.dirname, '..')
const listMode = process.argv.includes('--list')
const writeMode = process.argv.includes('--write')

/** Scope of the bilingual contract: the root README and the docs tree. */
const SCOPE_PATTERNS = ['README.md', 'README.zh.md', 'README.i18n.yaml', 'docs/**/*.md', 'docs/**/*.i18n.yaml']

/** The enforcement frontier and the never-paired set (docs/i18n/README.md § Scope). */
interface Manifest {
  required: string[]
  excluded: string[]
}
const manifest = JSON.parse(readFileSync(join(root, 'scripts/translation-pairing.manifest.json'), 'utf8')) as Manifest

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

/**
 * The structural signature the two sides must share, as ordered sequences so
 * a swap or a level change is caught, not just a count change. Prose is
 * deliberately absent: the gate checks shape, never wording.
 */
interface Signature {
  /** Heading depths in document order (h2 → 2). */
  headings: number[]
  /** Fenced code blocks verbatim: info string + content, in order. */
  code: string[]
  /** Column count of each table, in order. */
  tables: number[]
  /** Each list's kind (ordered vs bullet), in order. */
  lists: string[]
  /** Every link target in order, the language switcher's excluded. */
  links: string[]
}

/** Whether the tree contains a link to exactly `target` (the switcher check). */
function linksTo(tree: Nodes, target: string): boolean {
  let found = false
  const visit = (node: Nodes): void => {
    if (node.type === 'link' && node.url === target) found = true
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(tree)
  return found
}

/** Collect the structural signature, skipping links to `switcherTarget`. */
function signatureOf(tree: Nodes, switcherTarget: string): Signature {
  const sig: Signature = { headings: [], code: [], tables: [], lists: [], links: [] }
  const visit = (node: Nodes): void => {
    switch (node.type) {
      case 'heading':
        sig.headings.push(node.depth)
        break
      case 'code':
        sig.code.push(`\`\`\`${node.lang ?? ''}${node.meta ? ` ${node.meta}` : ''}\n${node.value}`)
        break
      case 'table':
        sig.tables.push(node.children[0]?.children.length ?? 0)
        break
      case 'list':
        sig.lists.push(node.ordered ? 'ordered' : 'bullet')
        break
      case 'link':
        if (node.url !== switcherTarget) sig.links.push(node.url)
        break
      default:
        // Every other node kind is prose or container — not part of the signature.
        break
    }
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(tree)
  return sig
}

/** Render a signature element for an error message, truncated for readability. */
function show(value: string | number | undefined): string {
  if (value === undefined) return 'nothing'
  const text = JSON.stringify(value)
  return text.length > 72 ? `${text.slice(0, 72)}…` : text
}

/** First divergence between two signatures, as messages; empty when identical. */
function signatureDiff(source: Signature, zh: Signature): string[] {
  const out: string[] = []
  const fields: [string, (string | number)[], (string | number)[]][] = [
    ['heading (depth)', source.headings, zh.headings],
    ['code block', source.code, zh.code],
    ['table (column count)', source.tables, zh.tables],
    ['list (kind)', source.lists, zh.lists],
    ['link target', source.links, zh.links],
  ]
  for (const [field, s, z] of fields) {
    const length = Math.max(s.length, z.length)
    for (let i = 0; i < length; i++) {
      if (s[i] !== z[i]) {
        out.push(`${field} #${i + 1} diverges between the pair: ${show(s[i])} vs ${show(z[i])}`)
        break
      }
    }
  }
  return out
}

function parse(content: string): Nodes {
  return fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

// Enumerate the scope once.
const files = new Set<string>()
for (const pattern of SCOPE_PATTERNS) {
  for (const match of globSync(pattern, { cwd: root })) files.add(match)
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

// 2. Every pair that exists at all is complete and consistent. Anchor on the
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

  const sourceTree = parse(sourceContent.toString('utf8'))
  const zhTree = parse(zhContent.toString('utf8'))
  if (!linksTo(zhTree, basename(source))) {
    errors.push(`${zh}: missing language switcher — no link to ${basename(source)}`)
  }
  if (!linksTo(sourceTree, basename(zh))) {
    errors.push(`${source}: missing language switcher — no link back to ${basename(zh)}`)
  }
  for (const divergence of signatureDiff(signatureOf(sourceTree, basename(zh)), signatureOf(zhTree, basename(source)))) {
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
    console.log(`${status.padEnd(11)} ${file}${status === 'missing' ? (required ? '  (required)' : '  (backlog)') : ''}`)
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
