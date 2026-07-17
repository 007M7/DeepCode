/**
 * Doc-sync gate: verify the fenced ```yaml examples in the website against
 * the loader and the workspace truth. A `cordis.yml` example that names a
 * plugin that does not exist, or passes a config key the plugin never
 * declared, is worse than no example — it fails silently for the reader.
 *
 * Scope: `website/zh-CN/**​/*.md`, EXCLUDING `website/zh-CN/api/**` (the api
 * pages are generator-owned — their yaml examples are verified at generation
 * time by a later stream, not re-checked here). Blocks opt out with
 * ` ```yaml ignore-check ` (same philosophy as doc-typecheck's opt-out: the
 * count is reported, an unchecked block is a visible decision, not a silent
 * hole — placeholder plugin names in tutorials are the legitimate case).
 *
 * Each checked block is parsed with the loader's REAL schema —
 * `JSON_SCHEMA` extended with the `!!js` scalar type exactly as
 * vendor/include/src/index.ts declares it — so `!!js process.env.X` parses
 * here iff it parses at runtime. Then:
 *
 * - Root is an ARRAY → a cordis.yml entry list. Every item must be a mapping
 *   with a string `name` and only the keys `EntryOptions` declares
 *   (vendor/loader/src/config/entry.ts plus the isolate.ts merge:
 *   id, name, config, group, disabled, inject, intercept, isolate).
 *   - `./` / `../` names are illustrative local plugins — existence is not
 *     checkable, skip. `group:*` names are loader built-ins; their `config`
 *     is itself an entry list and is recursed into.
 *   - Any other name must be a real workspace package (`packages/*​/*` and
 *     `vendor/*` package.json names).
 *   - For `@deepseek-ai/dsh-*` names the config-catalog generator is the
 *     truth: kind `config` → the yaml `config`'s top-level keys must be
 *     properties of the declared config type (member names of the first
 *     catalog paste ∪ top-level segments of the runtime schema keys);
 *     config-free kinds → a non-empty `config` mapping is a violation;
 *     seam/library kinds → name existence only (loading one directly is
 *     dubious, but that is a docs-prose concern, not this gate's).
 * - Root is a MAPPING or scalar → a fragment (e.g. a bare `config:` excerpt):
 *   syntax check only.
 *
 * This is a checker, not a fixer: it reports `file:line message` and exits 1.
 *
 * Run: `tsx scripts/verify-website-yaml.ts`.
 */

import { globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import ts from 'typescript'
import { collectConfigCatalog, type CatalogEntry } from './gen-config-catalog.ts'
import { extractFences } from './md-fences.ts'

const root = resolve(import.meta.dirname, '..')

/** Mirror of the loader's yaml schema (vendor/include/src/index.ts): the
 * `!!js` tag parses to an expression wrapper, everything else is JSON. */
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: data => typeof data === 'string',
  construct: (data: string) => ({ __jsExpr: data }),
})
const schema = yaml.JSON_SCHEMA.extend(JsExpr)

/** The exact key set an entry mapping may carry: `EntryOptions` in
 * vendor/loader/src/config/entry.ts plus the isolate.ts interface merge. */
const ENTRY_KEYS = ['id', 'name', 'config', 'group', 'disabled', 'inject', 'intercept', 'isolate'] as const

/** One `file:line message` finding. */
interface Violation {
  file: string
  /** 1-based line of the block's opening fence. */
  line: number
  message: string
}

/** One extracted ```yaml block. */
interface Block {
  file: string
  /** 1-based line of the opening fence. */
  line: number
  kind: 'check' | 'ignore'
  code: string
}

/** Extract every ```yaml / ```yaml ignore-check block from one Markdown file. */
function extractBlocks(file: string): Block[] {
  return extractFences(resolve(root, file), info =>
    info === 'yaml' ? 'check' : info === 'yaml ignore-check' ? 'ignore' : null)
    .map(f => ({ file, line: f.line, kind: f.kind, code: f.code }))
}

/** Every workspace package name: `packages/<group>/<pkg>` and `vendor/<pkg>`. */
function knownPackages(): Set<string> {
  const names = new Set<string>()
  for (const pattern of ['packages/*/*/package.json', 'vendor/*/package.json']) {
    for (const match of globSync(pattern, { cwd: root })) {
      const pkg: unknown = JSON.parse(readFileSync(resolve(root, match), 'utf8'))
      if (typeof pkg === 'object' && pkg !== null && 'name' in pkg && typeof pkg.name === 'string') {
        names.add(pkg.name)
      }
    }
  }
  return names
}

/** The catalog, built once on first `@deepseek-ai/dsh-*` name, keyed by pkg. */
let catalogByPkg: Map<string, CatalogEntry> | null = null
function catalogFor(pkg: string): CatalogEntry | undefined {
  catalogByPkg ??= new Map(collectConfigCatalog().map(e => [e.pkg, e]))
  return catalogByPkg.get(pkg)
}

/** Top-level property names of the first catalog paste (the verbatim config
 * type declaration), parsed as source text. */
function pasteKeys(paste: string): Set<string> {
  const sf = ts.createSourceFile('paste.ts', paste, ts.ScriptTarget.Latest, true)
  const keys = new Set<string>()
  const addMembers = (members: ts.NodeArray<ts.TypeElement>): void => {
    for (const m of members) {
      if (ts.isPropertySignature(m) || ts.isMethodSignature(m)) {
        const name = m.name
        keys.add(ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : name.getText(sf))
      }
    }
  }
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt)) addMembers(stmt.members)
    else if (ts.isTypeAliasDeclaration(stmt) && ts.isTypeLiteralNode(stmt.type)) addMembers(stmt.type.members)
  }
  return keys
}

/** The allowed top-level config keys of a kind-`config` catalog entry: the
 * first paste's member names ∪ the schema keys' top-level segments
 * (`agents[].id` → `agents`). Cached per entry. */
const allowedKeysCache = new Map<string, Set<string>>()
function allowedConfigKeys(entry: CatalogEntry): Set<string> {
  const cached = allowedKeysCache.get(entry.pkg)
  if (cached) return cached
  const keys = pasteKeys(entry.pastes?.[0]?.text ?? '')
  for (const path of entry.schemaKeys ?? []) {
    const top = path.split('.')[0]?.replace(/\[\]$/, '')
    if (top) keys.add(top)
  }
  allowedKeysCache.set(entry.pkg, keys)
  return keys
}

/** A parsed yaml mapping (arrays and `!!js` wrappers excluded). */
function asMapping(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  if ('__jsExpr' in value) return null
  return value as Record<string, unknown>
}

/** Check one cordis.yml entry list (recursing into `group:` sub-lists). */
function checkEntryList(
  items: unknown[],
  known: Set<string>,
  block: Block,
  violations: Violation[],
): void {
  const flag = (message: string): void => {
    violations.push({ file: block.file, line: block.line, message })
  }
  items.forEach((item, index) => {
    const at = `entry ${index + 1}`
    const entry = asMapping(item)
    if (!entry) {
      flag(`${at}: not a mapping`)
      return
    }
    const name = entry['name']
    if (typeof name !== 'string') {
      flag(`${at}: missing string \`name\``)
      return
    }
    for (const key of Object.keys(entry)) {
      if (!(ENTRY_KEYS as readonly string[]).includes(key)) {
        flag(`${at} (${name}): unknown entry key \`${key}\` (EntryOptions allows: ${[...ENTRY_KEYS].join(', ')})`)
      }
    }
    // Illustrative local plugin — nothing on disk to check against.
    if (name.startsWith('./') || name.startsWith('../')) return
    // A `group:`-style pseudo-name is NOT loadable: tree.import() only
    // special-cases the `cordis:` prefix, and nothing in this repo registers
    // loader builtins — reject it and point at the real group plugin.
    if (name.startsWith('group:')) {
      flag(`${at}: \`${name}\` is not loadable (no loader builtin is registered); use \`@cordisjs/plugin-group\` with \`group: true\``)
      return
    }
    // The vendored group plugin: its config is a nested entry list.
    if (name === '@cordisjs/plugin-group') {
      if (Array.isArray(entry['config'])) checkEntryList(entry['config'], known, block, violations)
      return
    }
    if (!known.has(name)) {
      flag(`${at}: unknown plugin \`${name}\` (not a workspace package)`)
      return
    }
    if (!name.startsWith('@deepseek-ai/dsh-')) return
    const catalog = catalogFor(name)
    if (!catalog) return
    const config = asMapping(entry['config'])
    if (catalog.kind === 'config') {
      if (!config) return
      const allowed = allowedConfigKeys(catalog)
      for (const key of Object.keys(config)) {
        if (!allowed.has(key)) {
          flag(`${at}: \`${name}\` has no config key \`${key}\` (known keys: ${[...allowed].sort().join(', ')})`)
        }
      }
    } else if (catalog.kind === 'no-config') {
      if (config && Object.keys(config).length > 0) {
        flag(`${at}: \`${name}\` declares no config, but the example passes one`)
      }
    }
    // seam / library: loading one directly is dubious, but that is a prose
    // concern — this gate only vouches for name existence.
  })
}

const files = globSync('website/zh-CN/**/*.md', { cwd: root })
  .filter(f => !f.startsWith('website/zh-CN/api/'))
  .sort()

const violations: Violation[] = []
const known = knownPackages()
let entryLists = 0
let fragments = 0
let ignored = 0
let scanned = 0

for (const file of files) {
  for (const block of extractBlocks(file)) {
    scanned++
    if (block.kind === 'ignore') {
      ignored++
      continue
    }
    let parsed: unknown
    try {
      parsed = yaml.load(block.code, { schema })
    } catch (error) {
      const message = error instanceof Error ? error.message.split('\n')[0] ?? 'parse error' : String(error)
      violations.push({ file: block.file, line: block.line, message: `yaml parse error: ${message}` })
      continue
    }
    if (Array.isArray(parsed)) {
      entryLists++
      checkEntryList(parsed, known, block, violations)
    } else {
      // Mapping or scalar root: a fragment (e.g. a bare `config:` excerpt) —
      // syntax is all there is to check.
      fragments++
    }
  }
}

if (violations.length === 0) {
  console.log(
    `verify-website-yaml: ${scanned} yaml block(s) in ${files.length} file(s): `
    + `${entryLists} entry list(s) + ${fragments} fragment(s) checked, ${ignored} ignore-check skipped.`,
  )
  process.exit(0)
}

console.error('verify-website-yaml: invalid yaml examples found:')
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}  ${v.message}`)
}
process.exit(1)
