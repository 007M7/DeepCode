/**
 * Doc-sync gate: verify every ` ```ts type-equiv ` block in the docs is a
 * VERBATIM copy of the source type definition it documents.
 *
 * The core-data-structures docs paste real type definitions so a reader sees
 * the exact shape. A paste drifts the moment source changes — this script is
 * the drift guard. For each block it extracts the documented symbol's
 * declaration from source via the TypeScript compiler API, whitespace-
 * normalizes both the source text and the block, and asserts they are equal.
 *
 * Provenance lives in a central manifest (`scripts/type-equiv.manifest.json`),
 * NOT in the doc prose: each entry names `{ doc, symbol, source }`. The script
 * enforces a 1:1 correspondence — every type-equiv block in the docs has
 * exactly one manifest entry (keyed by doc + declared symbol), and every
 * manifest entry resolves to exactly one block. An orphan on either side fails,
 * so a block can never be silently unchecked and an entry can never rot.
 *
 * doc-typecheck.ts recognizes the same ` ```ts type-equiv ` fence and skips it
 * (it is not standalone-compilable and is not counted in the opt-out ratio);
 * the two scripts share the fence, this one owns the verification.
 *
 * Run: `tsx scripts/verify-type-equiv.ts`.
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { glob } from 'node:fs/promises'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')

/**
 * Markdown globs scanned for ` ```ts type-equiv ` blocks — the SAME scope
 * doc-typecheck uses. Scanning every doc (not only the docs the manifest names)
 * is what makes the 1:1 guarantee real in both directions: a type-equiv block
 * added to a doc with NO manifest entry is still discovered here and reported as
 * an orphan, instead of being silently skipped.
 */
const MARKDOWN_GLOBS = ['README.md', 'docs/**/*.md', 'packages/*/README.md']

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

/** Collapse a declaration to its structural form for comparison: drop comments
 * (block + line), then collapse all whitespace runs to single spaces. This lets
 * a doc block show a CLEAN definition (without source's verbose inline JSDoc)
 * while still guaranteeing the field shapes match — drift in a field name or
 * type fails; a reworded inline comment does not. Adequate for our own type
 * source (no string literal contains `//` or `/* *​/`); not a general tokenizer. */
function normalize(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Strip a leading `export ` / `export default ` modifier — the doc block shows
 * the bare declaration, the source carries the export modifier. */
function stripExport(code: string): string {
  return code.replace(/^export\s+(default\s+)?/, '')
}

/** Parse the declared symbol name from a type-equiv block body. */
function blockSymbol(code: string): string | null {
  const m = /(?:export\s+(?:default\s+)?)?(?:abstract\s+)?(?:interface|type|class|enum)\s+([A-Za-z0-9_]+)/.exec(code)
  return m?.[1] ?? null
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

/** The declaration text of `symbol` in `sourceRel`, with `export` stripped, or
 * null when the symbol is not declared there. Uses the TS parser so it spans
 * interfaces, type aliases (including mapped/generic ones), classes, and enums
 * uniformly, and excludes the leading JSDoc (getStart skips leading trivia)
 * while keeping inline member comments. */
function sourceDeclaration(sourceRel: string, symbol: string): string | null {
  const abs = resolve(root, sourceRel)
  const text = readFileSync(abs, 'utf8')
  const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, /* setParentNodes */ true)
  for (const stmt of sf.statements) {
    const named =
      ts.isInterfaceDeclaration(stmt) || ts.isTypeAliasDeclaration(stmt)
      || ts.isClassDeclaration(stmt) || ts.isEnumDeclaration(stmt)
    if (named && stmt.name?.text === symbol) {
      return stripExport(stmt.getText(sf))
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
  for await (const match of glob(pattern, { cwd: root })) docSet.add(match)
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
  if (normalize(decl) !== normalize(stripExport(b.code))) {
    errors.push(
      `DRIFT: ${e.doc}:${b.line} — type-equiv block for ${e.symbol} does not match ${e.source}.\n`
      + `    source: ${normalize(decl)}\n`
      + `    doc:    ${normalize(stripExport(b.code))}`,
    )
    continue
  }
  verified++
}

if (errors.length === 0) {
  console.log(`verify-type-equiv: ${verified} type-equiv block(s) match source (1:1 with manifest).`)
  process.exit(0)
}

console.error('verify-type-equiv: type-equiv verification failed:')
for (const e of errors) console.error(`  ${e}`)
console.error(`\n(checked ${blocks.length} block(s) across ${new Set(blocks.map(b => b.doc)).size} doc(s); manifest at scripts/type-equiv.manifest.json)`)
process.exit(1)
