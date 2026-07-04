/**
 * Generate (and verify) the persistence log event catalog in
 * docs/persistence-catalog/log-events.md.
 *
 * The catalog is the ON-DISK-vocabulary reference: every event type that can
 * appear in a session's durable event log — every member of the
 * merge-extensible `SessionEventMap`, across the owning declaration in
 * `@deepseek-ai/dsh-session` and every plugin declaration merge. It complements
 * the cordis events/services catalog (the live bus wiring — a log event is NOT
 * a cordis event; it reaches listeners via the single `session/event` emit) and
 * the core-data-structures session page (the `SessionEvent` envelope and
 * derivation semantics): this page is the RECORDS a persisted log can contain.
 *
 *   `tsx scripts/gen-persistence-catalog.ts`          → write the catalog
 *   `tsx scripts/gen-persistence-catalog.ts --check`  → exit 1 if the committed
 *                                                       file is stale (CI /
 *                                                       pre-push gate)
 *
 * Like its AST sibling `gen-cordis-catalog.ts` (and unlike the boot-based
 * `gen-tool-catalog.ts`), this is a pure source pass: every log event is a
 * string-literal-named property with a static type annotation, so the AST is
 * the whole truth and a brand-new event (core or merged) appears in the next
 * regenerate — an un-regenerated file fails `--check`. The walk enforces JSDoc
 * COMPLETENESS on the whole vocabulary: every member carries description prose
 * (it becomes the catalog entry), and an `@mode` tag on a member is a hard
 * error — dispatch modes belong to cordis bus events, and a log event has none
 * (see docs/rfc/implemented/process/2026-07-04-persistence-log-catalog.md).
 * Structural holes are hard errors for the same reason: a member that is not a
 * property signature with an explicit payload type, an `extends` clause on a
 * declaration, a top-level `interface SessionEventMap` that is not the single
 * exported declaration in the owning package, and a duplicate declaration of
 * one event would each let something join (or impersonate)
 * `keyof SessionEventMap` without a truthful catalog row. Violations aggregate
 * into ONE error listing every offender.
 *
 * The surface/log-only badge is parsed from the `SurfaceEventType` union in the
 * owning package (never hand-listed here), and every union member must name a
 * collected event — a stale union member is a hard error.
 *
 * Payload fences use the ` ```ts persistence-catalog ` info string:
 * doc-typecheck recognizes it and skips compilation (a bare payload fragment is
 * not standalone-compilable), excluded from the opt-out ratio.
 */

import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const OUT = 'docs/persistence-catalog/log-events.md'

/** The fenced-block info string for generated payload blocks (skipped by
 * doc-typecheck, since a bare payload fragment is not standalone-compilable). */
const FENCE = 'ts persistence-catalog'

/** The package whose module id plugin merges augment (`declare module '…'`). */
const SESSION_MODULE = '@deepseek-ai/dsh-session'

/**
 * Cross-link map: a type name that appears in a payload → the
 * core-data-structures page that documents it (path relative to OUT's folder).
 * Hand-curated and catalog-owned, same policy as the cordis catalog's map: each
 * name resolves to exactly one PRIMARY page. A payload type with no
 * core-data-structures home (e.g. `HookDialect`, documented in its package)
 * simply gets no link.
 */
const LINK_MAP: Record<string, string> = {
  CallId: 'core.md',
  ContentBlock: 'core.md',
  MessageSource: 'core.md',
  StreamChunk: 'llm-streaming.md',
  TokenUsage: 'llm-streaming.md',
  TodoItem: 'session.md',
  TurnTrigger: 'session.md',
  TurnEndReason: 'session.md',
}

/** One log event, extracted from a `SessionEventMap` declaration. */
export interface LogEventEntry {
  /** Scoped name, e.g. `turn/start`. */
  name: string
  /** The scope prefix, e.g. `turn` (everything before the first `/`). */
  scope: string
  /** Payload type text (the member's type annotation, whitespace-collapsed). */
  payload: string
  /** Description prose (the member's JSDoc), one line per paragraph. */
  doc: string
  /** Source pointer `packages/…/file.ts:line` of the declaration. */
  source: string
}

/** A {@link LogEventEntry} plus its surface-eligibility badge. */
export interface AnnotatedLogEventEntry extends LogEventEntry {
  /** Whether the type is a `SurfaceEventType` member (may carry `surfaceOp`). */
  surface: boolean
}

/** Repo-relative source pointer `file:line` for a node's first character. */
function pointer(rel: string, sf: ts.SourceFile, node: ts.Node): string {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
  return `${rel}:${line + 1}`
}

const printer = ts.createPrinter({ removeComments: true })

/**
 * One-line payload text for a member's type annotation. Printed through the
 * TypeScript printer (not sliced from source text): the printer emits `;`
 * member separators regardless of how the source separated them, so a
 * multi-line newline-separated type literal still collapses to a VALID
 * single-line fragment. The trailing `;` the printer puts before every `}` is
 * dropped to match the repo's inline-literal style.
 */
function payloadText(type: ts.TypeNode, sf: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, type, sf)
    .replace(/\s+/g, ' ')
    .replace(/;\s*\}/g, ' }')
    .trim()
}

/** The raw `/** … *​/` JSDoc block immediately preceding a node, or '' if none. */
function rawJsDoc(text: string, node: ts.Node): string {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []
  const jsdoc = ranges.filter(r => text.slice(r.pos, r.pos + 3) === '/**').at(-1)
  return jsdoc ? text.slice(jsdoc.pos, jsdoc.end) : ''
}

/**
 * Parse a raw JSDoc block into description prose, flagging whether any `@mode`
 * tag is present (forbidden on log events). Output obeys the repo's markdown
 * conventions so the generated file passes verify-md-wrap: each prose paragraph
 * collapses to ONE physical line, and a `-` bullet list is preserved with each
 * item on its own single line (continuation lines folded in). `{@link Foo}`
 * unwraps to `Foo`. Description prose ends at the FIRST block tag (standard
 * JSDoc semantics): tag lines and their continuation lines are never prose.
 */
function parseJsDoc(raw: string): { doc: string; hasMode: boolean } {
  const inner = raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map(l => l.replace(/^\s*\*?\s?/, '').replace(/\s+$/, ''))
  let hasMode = false
  let inTags = false
  const blocks: string[] = []
  let para: string[] = []
  let list: string[] = []
  let item: string[] = []
  const join = (parts: string[]): string => parts.join(' ').replace(/\s+/g, ' ').trim()
  const flushItem = (): void => {
    if (item.length) list.push(join(item))
    item = []
  }
  const flushList = (): void => {
    flushItem()
    if (list.length) blocks.push(list.join('\n')) // one block, items on own lines
    list = []
  }
  const flushPara = (): void => {
    flushList()
    if (para.length) blocks.push(join(para))
    para = []
  }
  for (const line of inner) {
    // Tag detection runs on the trimmed line: the normalization above strips at
    // most one post-`*` space, so an extra-indented `*  @mode` still reaches
    // here with leading whitespace and must not leak into prose.
    const tagLine = line.trimStart()
    if (/^@mode\b/.test(tagLine)) { hasMode = true; flushPara(); inTags = true; continue }
    if (tagLine.startsWith('@')) { flushPara(); inTags = true; continue }
    if (inTags) continue // block-tag territory: continuations are never prose
    if (line.trim() === '') { flushPara(); continue }
    if (/^-\s+/.test(line)) {
      // A list item starts: a pending paragraph (e.g. an intro line directly
      // above the list, no blank between) flushes FIRST so it renders above.
      flushItem()
      if (para.length) { blocks.push(join(para)); para = [] }
      item.push(line)
      continue
    }
    if (item.length) { item.push(line); continue } // continuation of current item
    para.push(line)
  }
  flushPara()
  const doc = blocks.join('\n\n').replace(/\{@link\s+([^}]+)\}/g, '$1').trim()
  return { doc, hasMode }
}

/**
 * Throw one aggregate error for every completeness violation a walk collected.
 * Aggregation is deliberate: a remediation pass sees the whole list at once
 * instead of replaying the gate once per offender.
 */
function reportViolations(violations: string[]): void {
  if (violations.length === 0) return
  throw new Error(
    `gen-persistence-catalog: ${violations.length} JSDoc completeness violation(s):\n`
    + violations.map(v => `  ${v}`).join('\n'),
  )
}

/**
 * Every `interface SessionEventMap` declaration in a source file: the owning
 * top-level declaration (in `@deepseek-ai/dsh-session`) and any declaration
 * merge inside a `declare module '@deepseek-ai/dsh-session'` block. Both forms
 * declare members of the SAME merged interface, so both are catalogued
 * uniformly. `topLevel` distinguishes the owning form so the caller can verify
 * it actually lives in the owning package — an unrelated local interface that
 * happens to share the name must not be catalogued as the on-disk vocabulary.
 */
function sessionEventMapDecls(sf: ts.SourceFile): { decl: ts.InterfaceDeclaration; topLevel: boolean }[] {
  const decls: { decl: ts.InterfaceDeclaration; topLevel: boolean }[] = []
  for (const stmt of sf.statements) {
    if (ts.isInterfaceDeclaration(stmt) && stmt.name.text === 'SessionEventMap') decls.push({ decl: stmt, topLevel: true })
    if (ts.isModuleDeclaration(stmt) && ts.isStringLiteral(stmt.name) && stmt.name.text === SESSION_MODULE
      && stmt.body && ts.isModuleBlock(stmt.body)) {
      for (const inner of stmt.body.statements) {
        if (ts.isInterfaceDeclaration(inner) && inner.name.text === 'SessionEventMap') decls.push({ decl: inner, topLevel: false })
      }
    }
  }
  return decls
}

/**
 * The npm package name owning a `packages/<group>/<pkg>/…` source file, read
 * from that package's manifest — or null when the manifest is missing or
 * unparseable (the caller treats null as "ownership unverifiable").
 */
function packageNameFor(rel: string, scanRoot: string): string | null {
  const dir = rel.split('/').slice(0, 3).join('/')
  try {
    const manifest = JSON.parse(readFileSync(resolve(scanRoot, dir, 'package.json'), 'utf8')) as { name?: string }
    return typeof manifest.name === 'string' ? manifest.name : null
  } catch {
    // Missing or malformed package.json — every real workspace package has one,
    // so this only arises in stripped-down fixture trees; either way ownership
    // cannot be verified and the caller reports the declaration.
    return null
  }
}

/**
 * Walk every `SessionEventMap` declaration (the owning interface plus every
 * plugin declaration merge) and extract its events, hard-erroring (aggregated)
 * on any completeness violation: a member without description prose, an
 * `@mode` tag (a category error — log events have no dispatch mode), a member
 * that is not a property signature with an explicit payload type, a
 * non-literal member name, an `extends` clause (inherited keys would join
 * `keyof SessionEventMap` without a catalog row), a top-level declaration that
 * is not the single exported one in the owning package, or the same event
 * declared twice.
 * `scanRoot` defaults to the repo root; tests pass a fixture dir.
 */
export function collectLogEvents(scanRoot: string = root): LogEventEntry[] {
  const entries: LogEventEntry[] = []
  const violations: string[] = []
  const seen = new Map<string, string>()
  let owningDecl: string | null = null
  for (const rel of globSync('packages/*/*/src/**/*.ts', { cwd: scanRoot }).sort()) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!text.includes('SessionEventMap')) continue
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true)
    for (const { decl, topLevel } of sessionEventMapDecls(sf)) {
      const declSrc = pointer(rel, sf, decl)
      if (topLevel) {
        // The top-level form is the OWNING vocabulary, and it has exactly one
        // home: the single EXPORTED declaration in the owning package. A
        // same-named interface anywhere else — another package, a non-exported
        // local, a second exported copy — is a different type that must not be
        // catalogued as on-disk events.
        const pkg = packageNameFor(rel, scanRoot)
        if (pkg !== SESSION_MODULE) {
          violations.push(`top-level interface SessionEventMap (${declSrc}) is outside ${SESSION_MODULE} (package ${pkg ?? 'unknown'}). Rename the interface, or contribute events via declare module '${SESSION_MODULE}'.`)
          continue
        }
        const exported = decl.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false
        if (!exported) {
          violations.push(`top-level interface SessionEventMap (${declSrc}) is not exported; the owning vocabulary is the single exported declaration — rename a local helper interface.`)
          continue
        }
        if (owningDecl) {
          violations.push(`top-level interface SessionEventMap (${declSrc}) is already declared at ${owningDecl}; the owning vocabulary has exactly one home.`)
          continue
        }
        owningDecl = declSrc
      }
      if (decl.heritageClauses?.length) {
        violations.push(`SessionEventMap declaration (${declSrc}) uses extends; inherited keys would join keyof SessionEventMap without a catalog row — declare event members directly.`)
      }
      for (const member of decl.members) {
        const src = pointer(rel, sf, member)
        if (!ts.isPropertySignature(member) || !member.type) {
          // A method-form or type-less member still joins `keyof SessionEventMap`,
          // so skipping it silently would be exactly the undocumented-event hole
          // this catalog exists to close.
          const label = (member as { name?: ts.Node }).name?.getText(sf) ?? member.getText(sf).replace(/\s+/g, ' ')
          violations.push(`SessionEventMap member ${label} (${src}) is not a property signature with an explicit payload type; declare every log event as 'scope/name': <payload>.`)
          continue
        }
        if (!ts.isStringLiteral(member.name)) {
          violations.push(`log event at ${src} has a non-literal name; the catalog needs string-literal event names.`)
          continue
        }
        const name = member.name.text
        const where = `log event '${name}' (${src})`
        const prior = seen.get(name)
        if (prior) {
          violations.push(`${where} is already declared at ${prior}; an event type has exactly one declaration.`)
          continue
        }
        seen.set(name, src)
        const payload = payloadText(member.type, sf)
        const { doc, hasMode } = parseJsDoc(rawJsDoc(text, member))
        if (hasMode) {
          violations.push(`${where} carries an @mode tag, but a log event has no dispatch mode (it is not a cordis bus event — it rides the 'session/event' emit). Remove the tag.`)
        }
        if (!doc) {
          violations.push(`${where} has no description prose. Say what the event records and what its payload means — the JSDoc becomes the catalog entry.`)
        }
        entries.push({ name, scope: name.split('/')[0] ?? name, payload, doc, source: src })
      }
    }
  }
  reportViolations(violations)
  return entries
}

/**
 * Parse the `SurfaceEventType` union — the surface-eligible subset of event
 * types — from source. Hard-errors when the alias is missing, declared more
 * than once, or contains a non-string-literal member: the badge derivation
 * relies on the union being a closed set of literal event names.
 * `scanRoot` defaults to the repo root; tests pass a fixture dir.
 */
export function collectSurfaceEventTypes(scanRoot: string = root): string[] {
  const found: { names: string[]; source: string }[] = []
  for (const rel of globSync('packages/*/*/src/**/*.ts', { cwd: scanRoot }).sort()) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!text.includes('SurfaceEventType')) continue
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true)
    for (const stmt of sf.statements) {
      if (!ts.isTypeAliasDeclaration(stmt) || stmt.name.text !== 'SurfaceEventType') continue
      const src = pointer(rel, sf, stmt)
      const members = ts.isUnionTypeNode(stmt.type) ? [...stmt.type.types] : [stmt.type]
      const names: string[] = []
      for (const m of members) {
        if (ts.isLiteralTypeNode(m) && ts.isStringLiteral(m.literal)) names.push(m.literal.text)
        else throw new Error(`gen-persistence-catalog: SurfaceEventType (${src}) has a non-string-literal member; the badge derivation needs a closed literal union.`)
      }
      found.push({ names, source: src })
    }
  }
  const only = found[0]
  if (!only) throw new Error('gen-persistence-catalog: no SurfaceEventType union found under packages/*/*/src.')
  if (found.length > 1) throw new Error(`gen-persistence-catalog: SurfaceEventType is declared more than once (${found.map(f => f.source).join(', ')}); the surface subset has exactly one owner.`)
  return only.names
}

/**
 * Attach the surface/log-only badge to each event. Hard-errors when a
 * `SurfaceEventType` union member names no collected event — a stale union
 * member would otherwise silently badge nothing.
 */
export function annotateSurface(events: LogEventEntry[], surfaceTypes: string[]): AnnotatedLogEventEntry[] {
  const names = new Set(events.map(e => e.name))
  const stale = surfaceTypes.filter(t => !names.has(t))
  if (stale.length > 0) {
    throw new Error(`gen-persistence-catalog: SurfaceEventType member(s) ${stale.map(t => `'${t}'`).join(', ')} name no declared log event (stale union member?).`)
  }
  const surface = new Set(surfaceTypes)
  return events.map(e => ({ ...e, surface: surface.has(e.name) }))
}

/** Render the cross-link "Types:" line for a payload, or '' if none apply. */
function typeLinks(payload: string): string {
  const seen = new Set<string>()
  for (const name of Object.keys(LINK_MAP)) {
    if (new RegExp(`\\b${name}\\b`).test(payload)) seen.add(name)
  }
  if (seen.size === 0) return ''
  const links = [...seen].sort().map(n => `[${n}](../core-data-structures/${LINK_MAP[n]})`)
  return `Types: ${links.join(' · ')}`
}

/** Render one log event entry. */
function renderEvent(e: AnnotatedLogEventEntry): string[] {
  const out = [`#### \`${e.name}\` — ${e.surface ? 'surface' : 'log-only'}`, '']
  if (e.doc) out.push(e.doc, '')
  out.push('```' + FENCE, `'${e.name}': ${e.payload}`, '```', '')
  const links = typeLinks(e.payload)
  if (links) out.push(links, '')
  out.push(`Source: [\`${e.source}\`](../../${e.source.split(':')[0]})`, '')
  return out
}

/** Render the full catalog (pure, deterministic given the collected inputs). */
export function render(events: AnnotatedLogEventEntry[]): string {
  const lines: string[] = [
    '<!-- Generated by scripts/gen-persistence-catalog.ts — do not edit by hand.',
    '     Run `pnpm run gen-persistence-catalog` to regenerate. -->',
    '',
    '# Persistence Log Event Catalog',
    '',
    'Every event type that can appear in a session\'s durable event log: each member of the merge-extensible `SessionEventMap` — the owning vocabulary in `@deepseek-ai/dsh-session` plus every plugin declaration merge in this repo — with the payload it carries, its surface badge, and the declaration it comes from. It complements [session.md](../core-data-structures/session.md) (the `SessionEvent` envelope, surface list, and `deriveMessages()` projection), [persistence.md](../core-data-structures/persistence.md) (how the log is made durable), and the [cordis events catalog](../cordis-catalog/events.md) (the live bus wiring — a log event is NOT a cordis event; it reaches listeners via the single `session/event` emit).',
    '',
    'This file is GENERATED from source (`scripts/gen-persistence-catalog.ts`) and verified fresh by `pnpm run verify-persistence-catalog` (part of `doc-sync`) — do not edit it by hand. Payload blocks use a `ts persistence-catalog` fence (skipped by doc-typecheck, since a bare payload fragment is not standalone-compilable). Type names in a payload link to the page that documents them. See [the persistence-log-catalog RFC](../rfc/implemented/process/2026-07-04-persistence-log-catalog.md).',
    '',
    'The on-disk envelope around every payload is `SessionEvent` — `type`, monotonic `seq`, epoch-ms `time`, the `data` documented here, plus `surfaceOp`/`sourceEventSeqs` on **surface** events only ([envelope](../core-data-structures/session.md#sessioneventt--one-log-entry)). **surface** marks a `SurfaceEventType` member: it produces an LLM message and declares how it joins the surface list. **log-only** marks everything else: durable, replayable record with no derived-history contribution. Every payload is JSON-serializable (enforced at `Session.append`), and the whole format is pinned at `SESSION_FORMAT_VERSION = 0` — pre-release, no compatibility implied ([the version stance](../core-data-structures/persistence.md)). Scope: the packages in this repo; a downstream plugin can merge further event types, which are outside this catalog by construction.',
    '',
    '## Events',
    '',
  ]
  const scopes = [...new Set(events.map(e => e.scope))].sort()
  for (const scope of scopes) {
    lines.push(`### \`${scope}/*\``, '')
    for (const e of events.filter(x => x.scope === scope).sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(...renderEvent(e))
    }
  }
  return lines.join('\n')
}

/** CLI entry: default writes the catalog, `--check` fails if the committed copy
 * is stale. Guarded behind an entry-point check so importing this module for
 * tests neither regenerates the committed file nor calls process.exit. */
function main(): void {
  const content = render(annotateSurface(collectLogEvents(), collectSurfaceEventTypes()))
  if (process.argv.includes('--check')) {
    let committed: string | null = null
    try {
      committed = readFileSync(resolve(root, OUT), 'utf8')
    } catch {
      // Only ENOENT (not yet generated) is expected; a present-but-unreadable
      // file is not a state this repo produces. Either way the remedy is the
      // same — regenerate — so treat a read failure as "stale".
      committed = null
    }
    if (committed === content) {
      console.log(`gen-persistence-catalog: ${OUT} is up to date.`)
      process.exit(0)
    }
    console.error(`gen-persistence-catalog: ${OUT} is stale. Run \`pnpm run gen-persistence-catalog\` and commit ${OUT}.`)
    process.exit(1)
  }

  writeFileSync(resolve(root, OUT), content)
  console.log(`gen-persistence-catalog: wrote ${OUT}.`)
}

// Run only when invoked as a script, not when imported by a test.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
