/**
 * Doc-sync gate: enforce the bilingual pairing contract (docs/i18n/README.md).
 * English is canonical; the translation of `foo.md` is a sibling `foo.zh.md`
 * whose FIRST line fingerprints the English source it was translated from:
 *
 *   <!-- i18n-source: docs/foo.md@<first 12 hex of git blob hash> -->
 *
 * The gate checks, mechanically, everything the contract promises:
 *
 *   1. Every English file in the manifest's `required` list has a `.zh.md`
 *      sibling (the enforcement frontier — grows batch by batch).
 *   2. Every EXISTING `.zh.md`, required or not, is sound: its source exists
 *      (no orphans), its fingerprint equals the source's current blob hash
 *      (no stale translations), both sides carry the language-switcher link,
 *      and its fenced-code-block and heading counts match the source.
 *   3. `excluded` files (generated docs, agent instructions, the bilingual
 *      terminology table) have no `.zh.md` at all.
 *
 * The fingerprint is a git BLOB hash, not a commit hash, so a translation
 * updated in the same PR as its English source verifies without any history
 * lookup: staleness is a pure content comparison, computed here directly
 * (sha1 of `blob <size>\0<content>`) without spawning git.
 *
 * Run: `tsx scripts/verify-translation-pairing.ts` — or with `--list` to print
 * the translation state (missing/stale/ok) of every in-scope document as a
 * work list; `--list` always exits 0.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { glob } from 'node:fs/promises'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes } from 'mdast'

const root = resolve(import.meta.dirname, '..')
const listMode = process.argv.includes('--list')

/** Scope of the bilingual contract: the root README and the docs tree. */
const SCOPE_PATTERNS = ['README.md', 'README.zh.md', 'docs/**/*.md']

/** The enforcement frontier and the never-paired set (docs/i18n/README.md § Scope). */
interface Manifest {
  required: string[]
  excluded: string[]
}
const manifest = JSON.parse(readFileSync(join(root, 'scripts/translation-pairing.manifest.json'), 'utf8')) as Manifest

/** First line of a translation: fingerprint of the English source it renders. */
const FINGERPRINT = /^<!-- i18n-source: (?<path>\S+)@(?<hash>[0-9a-f]{12}) -->$/

/** An excluded entry ending in `/` excludes the whole directory. */
function isExcluded(file: string): boolean {
  return manifest.excluded.some(entry => (entry.endsWith('/') ? file.startsWith(entry) : file === entry))
}

/** Git blob hash (what `git hash-object` prints), truncated to 12 hex digits. */
function blobHash(content: Buffer): string {
  const hash = createHash('sha1')
  hash.update(`blob ${content.byteLength}\0`)
  hash.update(content)
  return hash.digest('hex').slice(0, 12)
}

/** Counts that must match between a source and its translation. */
interface Shape {
  codeBlocks: number
  headings: number
}

/** Whether `text` contains a relative markdown link to exactly `target`. */
function linksTo(tree: Nodes, target: string): boolean {
  let found = false
  const visit = (node: Nodes): void => {
    if (node.type === 'link' && node.url === target) found = true
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(tree)
  return found
}

function shapeOf(tree: Nodes): Shape {
  let codeBlocks = 0
  let headings = 0
  const visit = (node: Nodes): void => {
    if (node.type === 'code') codeBlocks++
    if (node.type === 'heading') headings++
    if ('children' in node) for (const child of node.children) visit(child)
  }
  visit(tree)
  return { codeBlocks, headings }
}

function parse(content: string): Nodes {
  return fromMarkdown(content, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
}

// Enumerate the scope once, split into sources and translations.
const files = new Set<string>()
for (const pattern of SCOPE_PATTERNS) {
  for await (const match of glob(pattern, { cwd: root })) files.add(match)
}
const translations = [...files].filter(f => f.endsWith('.zh.md')).sort()
const sources = [...files].filter(f => !f.endsWith('.zh.md')).sort()

const errors: string[] = []
const state = new Map<string, 'ok' | 'stale' | 'missing'>()

// 1. Required pairs exist.
for (const req of manifest.required) {
  if (!existsSync(join(root, req))) {
    errors.push(`${req}: listed in translation-pairing.manifest.json \`required\` but the file does not exist`)
    continue
  }
  const zh = req.replace(/\.md$/, '.zh.md')
  if (!existsSync(join(root, zh))) {
    errors.push(`${req}: required to have a translation, but ${zh} does not exist`)
    state.set(req, 'missing')
  }
}

// 2. Every existing translation is sound.
for (const zh of translations) {
  const source = zh.replace(/\.zh\.md$/, '.md')
  const sourceAbs = join(root, source)
  if (!existsSync(sourceAbs)) {
    errors.push(`${zh}: orphan — its English source ${source} does not exist (delete or rename the translation alongside its source)`)
    continue
  }
  if (isExcluded(source)) {
    errors.push(`${zh}: ${source} is excluded from pairing (generated or bilingual-by-construction); this translation must not exist`)
    continue
  }

  const zhContent = readFileSync(join(root, zh), 'utf8')
  const firstLine = zhContent.slice(0, zhContent.indexOf('\n'))
  const match = FINGERPRINT.exec(firstLine)
  if (!match?.groups) {
    errors.push(`${zh}: first line is not an i18n-source fingerprint (expected \`<!-- i18n-source: ${source}@<12-hex> -->\`, got \`${firstLine.slice(0, 60)}\`)`)
    continue
  }
  if (match.groups['path'] !== source) {
    errors.push(`${zh}: fingerprint names ${match.groups['path']} but the sibling source is ${source}`)
    continue
  }

  const sourceContent = readFileSync(sourceAbs)
  const current = blobHash(sourceContent)
  if (match.groups['hash'] !== current) {
    errors.push(`${zh}: stale — fingerprint ${match.groups['hash']} but ${source} is now ${current} (update the translation, then re-fingerprint)`)
    state.set(source, 'stale')
    continue
  }

  const zhTree = parse(zhContent)
  const sourceTree = parse(sourceContent.toString('utf8'))
  if (!linksTo(zhTree, basename(source))) {
    errors.push(`${zh}: missing language switcher — no link to ${basename(source)}`)
  }
  if (!linksTo(sourceTree, basename(zh))) {
    errors.push(`${source}: missing language switcher — no link back to ${basename(zh)}`)
  }
  const zhShape = shapeOf(zhTree)
  const sourceShape = shapeOf(sourceTree)
  if (zhShape.codeBlocks !== sourceShape.codeBlocks) {
    errors.push(`${zh}: ${zhShape.codeBlocks} fenced code block(s) vs ${sourceShape.codeBlocks} in ${source} — code blocks must mirror the source`)
  }
  if (zhShape.headings !== sourceShape.headings) {
    errors.push(`${zh}: ${zhShape.headings} heading(s) vs ${sourceShape.headings} in ${source} — heading structure must mirror the source`)
  }
  if (!state.has(source)) state.set(source, 'ok')
}

// Complete the state map for --list: any in-scope, non-excluded source with no translation yet is backlog.
for (const source of sources) {
  if (!isExcluded(source) && !state.has(source)) state.set(source, 'missing')
}

if (listMode) {
  const order = { stale: 0, missing: 1, ok: 2 } as const
  const rows = [...state.entries()].sort((a, b) => order[a[1]] - order[b[1]] || a[0].localeCompare(b[0]))
  for (const [file, status] of rows) {
    const required = manifest.required.includes(file)
    console.log(`${status.padEnd(7)} ${file}${status === 'missing' ? (required ? '  (required)' : '  (backlog)') : ''}`)
  }
  const counts = { ok: 0, stale: 0, missing: 0 }
  for (const status of state.values()) counts[status]++
  console.log(`verify-translation-pairing: ${counts.ok} ok, ${counts.stale} stale, ${counts.missing} missing (of ${state.size} in scope)`)
  process.exit(0)
}

if (errors.length === 0) {
  console.log(`verify-translation-pairing: ${translations.length} translation(s) checked against ${manifest.required.length} required pair(s), all sound.`)
  process.exit(0)
}

console.error('verify-translation-pairing: bilingual pairing contract violated (see docs/i18n/README.md):')
for (const message of errors) console.error(`  ${message}`)
process.exit(1)
