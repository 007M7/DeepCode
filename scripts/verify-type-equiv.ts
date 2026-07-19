/**
 * Verify every `ts type-equiv` block against the source symbol named by the
 * manifest. Blocks and entries have a one-to-one relationship; comparison
 * ignores whitespace and non-JSDoc comments but preserves declaration
 * structure and every original JSDoc comment.
 */

import { globSync, readFileSync, existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')

/** Scan doc-typecheck's full Markdown scope so unmanifested blocks also fail. */
const MARKDOWN_GLOBS = ['README.md', 'docs/**/*.md', 'packages/*/*.md', 'packages/*/*/*.md', 'website/zh-CN/**/*.md']

/** One manifest entry: a documented type-equiv block and its source symbol. */
interface ManifestEntry {
  /** Doc file (repo-relative) containing the ` ```ts type-equiv ` block. */
  doc: string
  /** The declared symbol the block must match (e.g. `SessionEvent`). */
  symbol: string
  /** Source file (repo-relative) that exports the symbol. */
  source: string
}

/** One extracted ` ```ts type-equiv ` block. */
interface EquivBlock {
  doc: string
  /** 1-based line of the opening fence (for diagnostics). */
  line: number
  /** Symbol name parsed from the block's declaration. */
  symbol: string
  /** Block body (the pasted declaration). */
  code: string
}

/** Normalize declaration structure independently of comments and whitespace. */
function normalizeStructure(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Extract normalized JSDoc comments in source order. Type declarations in this
 * repository do not contain comment delimiters inside string literals.
 */
function normalizeJSDoc(code: string): string[] {
  return [...code.matchAll(/\/\*\*[\s\S]*?\*\//g)]
    .map(match => match[0].replace(/\s+/g, ' ').trim())
}

/** Strip source-only export modifiers. */
function stripExport(code: string): string {
  return code.replace(/^export\s+(default\s+)?/, '')
}

/** Parse the declared symbol name from a type-equiv block body. */
function blockSymbol(code: string): string | null {
  const sf = ts.createSourceFile('type-equiv.ts', code, ts.ScriptTarget.Latest, /* setParentNodes */ false, ts.ScriptKind.TS)
  for (const stmt of sf.statements) {
    const named =
      ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)
      || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)
    if (named && stmt.name) return stmt.name.text
  }
  return null
}

/** Extract every ` ```ts type-equiv ` block from one Markdown file. */
function extractEquivBlocks(docRel: string): EquivBlock[] {
  const text = readFileSync(resolve(root, docRel), 'utf8')
  const lines = text.split('\n')
  const blocks: EquivBlock[] = []
  let open: { line: number; body: string[] } | null = null

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? ''
    const fence = /^```(\s*)(\S.*)?$/.exec(raw)
    if (!fence) {
      if (open) open.body.push(raw)
      continue
    }
    if (open) {
      const code = open.body.join('\n')
      const symbol = blockSymbol(code)
      if (!symbol) {
        throw new Error(`verify-type-equiv: ${docRel}:${open.line} — type-equiv block has no parseable interface/type/class declaration`)
      }
      blocks.push({ doc: docRel, line: open.line, symbol, code })
      open = null
      continue
    }
    if ((fence[2] ?? '').trim() === 'ts type-equiv') open = { line: i + 1, body: [] }
  }
  if (open) throw new Error(`verify-type-equiv: ${docRel}:${open.line} — unterminated type-equiv block`)
  return blocks
}

/**
 * The declaration text of `symbol` in `sourceRel`, with `export` stripped, or
 * null when the symbol is not declared there. Uses the TS parser so it spans
 * interfaces, type aliases (including mapped/generic ones), classes, and enums
 * uniformly while including declaration and member JSDoc.
 */
function sourceDeclaration(sourceRel: string, symbol: string): string | null {
  const abs = resolve(root, sourceRel)
  const text = readFileSync(abs, 'utf8')
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, /* setParentNodes */ true)
  for (const stmt of sf.statements) {
    const named =
      ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)
      || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)
    if (named && stmt.name?.text === symbol) {
      const declarationStart = stmt.getStart(sf)
      const jsDoc = ts.getJSDocCommentsAndTags(stmt)
        .filter(ts.isJSDoc)
        .map(doc => text.slice(doc.pos, doc.end))
        .join('\n')
      const declaration = stripExport(text.slice(declarationStart, stmt.getEnd()))
      return jsDoc === '' ? declaration : `${jsDoc}\n${declaration}`
    }
  }
  return null
}

const manifestRaw = readFileSync(resolve(root, 'scripts/type-equiv.manifest.json'), 'utf8')
const manifest = JSON.parse(manifestRaw) as { entries: ManifestEntry[] }
const entries = manifest.entries

// Key a block/entry by doc + symbol (a symbol may be documented in more than one
// doc, but at most once per doc).
const keyOf = (x: { doc: string; symbol: string }): string => `${x.doc}::${x.symbol}`

// Collect every type-equiv block across ALL docs in scope — not only the docs
// the manifest names — so a block in an unmanifested doc is found and reported
// as an orphan rather than silently skipped.
const docSet = new Set<string>()
for (const pattern of MARKDOWN_GLOBS) {
  for (const match of globSync(pattern, { cwd: root })) docSet.add(match.split(sep).join('/'))
}
const blocks: EquivBlock[] = [...docSet].sort().flatMap(extractEquivBlocks)

const errors: string[] = []
// A manifest entry naming a doc that does not exist (or is outside the scanned
// scope, so no block could ever match it) is an error in its own right.
for (const d of [...new Set(entries.map(e => e.doc))]) {
  if (!existsSync(resolve(root, d))) errors.push(`manifest references ${d}, which does not exist`)
  else if (!docSet.has(d)) errors.push(`manifest references ${d}, which is outside the scanned markdown scope (${MARKDOWN_GLOBS.join(', ')})`)
}

// Duplicate-block guard: the same symbol twice in one doc is ambiguous.
const blockByKey = new Map<string, EquivBlock>()
for (const b of blocks) {
  const k = keyOf(b)
  const prior = blockByKey.get(k)
  if (prior) {
    errors.push(`duplicate type-equiv block for ${b.symbol} in ${b.doc} (lines ${prior.line} and ${b.line})`)
    continue
  }
  blockByKey.set(k, b)
}

// Duplicate-entry guard in the manifest.
const entryByKey = new Map<string, ManifestEntry>()
for (const e of entries) {
  const k = keyOf(e)
  if (entryByKey.has(k)) {
    errors.push(`duplicate manifest entry for ${e.symbol} in ${e.doc}`)
    continue
  }
  entryByKey.set(k, e)
}

// 1:1 correspondence: orphan blocks (no entry) and orphan entries (no block).
for (const b of blocks) {
  if (!entryByKey.has(keyOf(b))) {
    errors.push(`type-equiv block ${b.symbol} (${b.doc}:${b.line}) has no manifest entry — add one to scripts/type-equiv.manifest.json`)
  }
}
for (const e of entries) {
  if (!blockByKey.has(keyOf(e))) {
    errors.push(`manifest entry ${e.symbol} (${e.doc}) has no matching type-equiv block — remove it or add the block`)
  }
}

// Verbatim check: each matched block must equal its source declaration.
let verified = 0
for (const e of entries) {
  const b = blockByKey.get(keyOf(e))
  if (!b) continue // already reported as an orphan entry
  const decl = sourceDeclaration(e.source, e.symbol)
  if (decl === null) {
    errors.push(`symbol ${e.symbol} not found in ${e.source} (manifest entry for ${e.doc})`)
    continue
  }
  const doc = stripExport(b.code)
  const sourceStructure = normalizeStructure(decl)
  const docStructure = normalizeStructure(doc)
  const sourceJSDoc = normalizeJSDoc(decl)
  const docJSDoc = normalizeJSDoc(doc)
  if (sourceStructure !== docStructure || JSON.stringify(sourceJSDoc) !== JSON.stringify(docJSDoc)) {
    errors.push(
      `DRIFT: ${e.doc}:${b.line} — type-equiv block for ${e.symbol} does not match ${e.source}.\n`
      + `    source structure: ${sourceStructure}\n`
      + `    doc structure:    ${docStructure}\n`
      + `    source JSDoc:     ${JSON.stringify(sourceJSDoc)}\n`
      + `    doc JSDoc:        ${JSON.stringify(docJSDoc)}`,
    )
    continue
  }
  verified++
}

if (errors.length === 0) {
  console.log(`verify-type-equiv: ${verified} type-equiv block(s) match source structure and JSDoc (1:1 with manifest).`)
  process.exit(0)
}

console.error('verify-type-equiv: type-equiv verification failed:')
for (const e of errors) console.error(`  ${e}`)
console.error(`\n(checked ${blocks.length} block(s) across ${new Set(blocks.map(b => b.doc)).size} doc(s); manifest at scripts/type-equiv.manifest.json)`)
process.exit(1)
