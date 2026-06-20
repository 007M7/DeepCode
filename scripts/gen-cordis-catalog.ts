/**
 * Generate (and verify) the cordis events + services catalog in
 * docs/cordis-catalog/events-and-services.md.
 *
 * The catalog is the WIRING-axis reference: every cordis event a plugin can
 * listen to (exact signature + dispatch mode) and every `ctx.<key>` service it
 * can call (exact public interface). It complements the core-data-structures
 * catalog (the VOCABULARY axis — the types these signatures move around).
 *
 * The catalog is FULLY GENERATED from source — never hand-edit it. The codebase
 * is disciplined enough that a pure-AST pass captures the whole truthful
 * surface: every event/service is a string literal that round-trips to a static
 * `interface Events` / `interface Context` declaration (no dynamically-named
 * events, no runtime-only services). So the committed file is a build artifact
 * and a regenerate-and-diff freshness check (`--check`) makes drift structurally
 * impossible. Because generation enumerates source rather than checking a
 * hand-written subset, a brand-new event cannot be silently undocumented — it
 * appears in the next regenerate, and an un-regenerated file fails `--check`.
 *
 *   `tsx scripts/gen-cordis-catalog.ts`          → write the catalog
 *   `tsx scripts/gen-cordis-catalog.ts --check`  → exit 1 if the committed file
 *                                                  is stale (CI / pre-push gate)
 *
 * The HARNESS tier (the `@deepseek-ai/dsh-*` events + services) is rendered in
 * full from source: signature, the `@mode` badge, and the declaration's JSDoc.
 * Every harness event MUST carry an `@mode emit|waterfall|parallel` tag — the
 * generator hard-errors on a missing tag, and where the signature shape is
 * conclusive (a trailing `next: () => …` parameter is structurally a waterfall)
 * it asserts the tag agrees and hard-errors on a contradiction. The INHERITED
 * tier (cordis core + loader/hmr/timer) is pinned vendor source a plugin author
 * also sees; it is rendered tersely (name + one-line + source pointer) from a
 * curated table in this script, NOT elevated to the harness tier's prominence.
 *
 * Signature fences use the ` ```ts cordis-catalog ` info string: doc-typecheck
 * recognizes it and skips compilation (the signatures are fragments, not
 * standalone-compilable, like the ` ```ts type-equiv ` blocks).
 */

import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')
const OUT = 'docs/cordis-catalog/events-and-services.md'

/** The fenced-block info string for generated signature blocks (skipped by
 * doc-typecheck, since a bare signature fragment is not standalone-compilable). */
const FENCE = 'ts cordis-catalog'

/** A dispatch mode, rendered as the badge after an event name. */
type Mode = 'emit' | 'waterfall' | 'parallel'

/**
 * Cross-link map: a type name that appears in a signature → the
 * core-data-structures page that documents it (path relative to OUT's folder).
 * Hand-curated and catalog-owned, NOT derived from type-equiv.manifest.json —
 * that manifest documents the `…Map` symbols (`ContentBlockMap`) while
 * signatures reference the derived UNION names (`ContentBlock`), and it lists a
 * few symbols on two pages. Here each name resolves to exactly one PRIMARY page.
 */
const LINK_MAP: Record<string, string> = {
  Agent: 'core.md',
  ContentBlock: 'core.md',
  Message: 'core.md',
  MessageSource: 'core.md',
  GenerateOptions: 'core.md',
  GenerateResult: 'core.md',
  SessionEvent: 'core.md',
  StreamChunk: 'llm-streaming.md',
  TurnEndReason: 'session.md',
  ToolDefinition: 'tools.md',
  ToolExecution: 'tools.md',
  ToolExecutionResult: 'tools.md',
  BashExecRequest: 'bash.md',
  BashExecSpec: 'bash.md',
  BashRunResult: 'bash.md',
  BashTask: 'bash.md',
  BashTaskRead: 'bash.md',
}

/** One harness event, extracted from an `interface Events` block. */
interface EventEntry {
  /** Scoped name, e.g. `agent/request`. */
  name: string
  /** The scope prefix, e.g. `agent` (everything before the first `/`). */
  scope: string
  /** Full signature text (the method-signature member, JSDoc stripped). */
  signature: string
  /** Dispatch mode from the `@mode` tag. */
  mode: Mode
  /** Description prose (JSDoc minus the `@mode` tag), one line per paragraph. */
  doc: string
  /** Source pointer `packages/…/file.ts:line` of the declaration. */
  source: string
}

/** One harness service, extracted from an `interface Context` block. */
interface ServiceEntry {
  /** The `ctx.<key>` name, e.g. `llm`. */
  key: string
  /** The service class/interface name, e.g. `LlmService`. */
  type: string
  /** Whether the service class is abstract (a seam interface). */
  abstract: boolean
  /** Class-level JSDoc prose, one line per paragraph. */
  doc: string
  /** Public method signatures (bodies stripped), in source order. */
  methods: string[]
  /** Source pointer of the class declaration. */
  source: string
}

/** A terse inherited-tier entry (pinned vendor surface). */
interface InheritedEntry {
  name: string
  summary: string
  /** Source pointer `vendor/…:line`. */
  source: string
}

/** Repo-relative source pointer `file:line` for a node's first character. */
function pointer(rel: string, sf: ts.SourceFile, node: ts.Node): string {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
  return `${rel}:${line + 1}`
}

/** The raw `/** … *​/` JSDoc block immediately preceding a node, or '' if none. */
function rawJsDoc(text: string, node: ts.Node): string {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? []
  const jsdoc = ranges.filter(r => text.slice(r.pos, r.pos + 3) === '/**').at(-1)
  return jsdoc ? text.slice(jsdoc.pos, jsdoc.end) : ''
}

/**
 * Parse a raw JSDoc block into description prose + the `@mode` tag (when
 * present). Output obeys the repo's markdown conventions so the generated file
 * passes verify-md-wrap: each prose paragraph collapses to ONE physical line,
 * and a `-` bullet list is preserved with each item on its own single line
 * (continuation lines folded in). `{@link Foo}` unwraps to `Foo`; `@`-tag lines
 * other than `@mode` end the current prose run.
 */
function parseJsDoc(raw: string): { doc: string; mode: Mode | null } {
  const inner = raw
    .replace(/^\/\*\*/, '')
    .replace(/\*\/$/, '')
    .split('\n')
    .map(l => l.replace(/^\s*\*?\s?/, '').replace(/\s+$/, ''))
  let mode: Mode | null = null
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
    const m = /^@mode\s+(emit|waterfall|parallel)\s*$/.exec(line)
    if (m) { mode = m[1] as Mode; continue }
    if (line.startsWith('@')) { flushPara(); continue } // other tags end the prose
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
  return { doc, mode }
}

/** Find the `declare module 'cordis'` body in a source file, or null. */
function cordisModuleBody(sf: ts.SourceFile): ts.ModuleBlock | null {
  for (const stmt of sf.statements) {
    if (ts.isModuleDeclaration(stmt) && ts.isStringLiteral(stmt.name) && stmt.name.text === 'cordis') {
      if (stmt.body && ts.isModuleBlock(stmt.body)) return stmt.body
    }
  }
  return null
}

/** The signature text of a method-signature member (everything but a body). */
function memberSignature(member: ts.TypeElement | ts.ClassElement, sf: ts.SourceFile): string {
  const full = member.getText(sf)
  const body = (member as { body?: ts.Node }).body
  const sig = body ? full.slice(0, full.length - body.getText(sf).length) : full
  return sig.replace(/\s*;?\s*$/, '').replace(/\s+/g, ' ').trim()
}

/** Walk every harness `interface Events` block and extract its events.
 * `scanRoot` defaults to the repo root; tests pass a fixture dir. */
export function collectEvents(scanRoot: string = root): EventEntry[] {
  const entries: EventEntry[] = []
  for (const rel of globSync('packages/*/src/*.ts', { cwd: scanRoot }).sort()) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!text.includes('interface Events')) continue
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true)
    const body = cordisModuleBody(sf)
    if (!body) continue
    for (const stmt of body.statements) {
      if (!ts.isInterfaceDeclaration(stmt) || stmt.name.text !== 'Events') continue
      for (const member of stmt.members) {
        if (!ts.isMethodSignature(member)) continue
        const name = ts.isStringLiteral(member.name) ? member.name.text : member.name.getText(sf)
        const signature = memberSignature(member, sf)
        const { doc, mode } = parseJsDoc(rawJsDoc(text, member))
        const src = pointer(rel, sf, member)
        if (!mode) {
          throw new Error(`gen-cordis-catalog: event '${name}' (${src}) is missing an @mode tag. Add '@mode emit|waterfall|parallel' to its JSDoc (see AGENTS.md).`)
        }
        // Conclusive structural check: a trailing `next: () => …` parameter is a
        // waterfall. (emit vs parallel is not structurally distinguishable, so
        // it is trusted from the tag.)
        const last = member.parameters.at(-1)
        const hasNext = !!last && last.name.getText(sf) === 'next'
        if (hasNext && mode !== 'waterfall') {
          throw new Error(`gen-cordis-catalog: event '${name}' (${src}) has a trailing 'next' parameter (structurally a waterfall) but is tagged '@mode ${mode}'. Fix the tag or the signature.`)
        }
        if (!hasNext && mode === 'waterfall') {
          throw new Error(`gen-cordis-catalog: event '${name}' (${src}) is tagged '@mode waterfall' but has no trailing 'next' parameter. A waterfall delegates via next().`)
        }
        entries.push({ name, scope: name.split('/')[0] ?? name, signature, mode, doc, source: src })
      }
    }
  }
  return entries
}

/** Walk every harness `interface Context` block + its service class.
 * `scanRoot` defaults to the repo root; tests pass a fixture dir. */
export function collectServices(scanRoot: string = root): ServiceEntry[] {
  const entries: ServiceEntry[] = []
  for (const rel of globSync('packages/*/src/index.ts', { cwd: scanRoot }).sort()) {
    const abs = resolve(scanRoot, rel)
    const text = readFileSync(abs, 'utf8')
    if (!text.includes('interface Context')) continue
    const sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true)
    const body = cordisModuleBody(sf)
    if (!body) continue
    // The ctx key → type mapping(s) declared in this file's interface Context.
    const keyToType = new Map<string, string>()
    for (const stmt of body.statements) {
      if (!ts.isInterfaceDeclaration(stmt) || stmt.name.text !== 'Context') continue
      for (const member of stmt.members) {
        if (!ts.isPropertySignature(member) || !member.type) continue
        const key = member.name.getText(sf)
        keyToType.set(key, member.type.getText(sf))
      }
    }
    if (keyToType.size === 0) continue
    // Find each service class declared in the same file and emit an entry.
    for (const [key, type] of keyToType) {
      const cls = sf.statements.find(
        (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === type,
      )
      if (!cls) continue // a Pick-mixin member (e.g. timer helpers), not a class here
      const abstract = cls.modifiers?.some(m => m.kind === ts.SyntaxKind.AbstractKeyword) ?? false
      const methods: string[] = []
      for (const member of cls.members) {
        if (!ts.isMethodDeclaration(member)) continue
        // Only the PUBLIC callable surface a `ctx.<key>` consumer sees. Drop
        // private/protected (a protected method like `notifyTaskDone` is a
        // subclass hook, not something a plugin calls through `ctx.bash`) and
        // static (not reachable through the instance).
        const nonPublic = member.modifiers?.some(m =>
          m.kind === ts.SyntaxKind.PrivateKeyword
          || m.kind === ts.SyntaxKind.ProtectedKeyword
          || m.kind === ts.SyntaxKind.StaticKeyword)
          || ts.isPrivateIdentifier(member.name)
        if (nonPublic) continue
        const memberName = member.name.getText(sf)
        if (memberName.startsWith('[')) continue // computed/symbol members
        methods.push(memberSignature(member, sf))
      }
      entries.push({
        key,
        type,
        abstract,
        doc: parseJsDoc(rawJsDoc(text, cls)).doc,
        methods,
        source: pointer(rel, sf, cls),
      })
    }
  }
  return entries.sort((a, b) => a.key.localeCompare(b.key))
}

/**
 * The inherited tier — cordis core + loader/hmr/timer. Curated, terse, and
 * hand-summarized because (a) it is pinned vendor source that changes only on a
 * deliberate vendor sync, (b) the cordis-core `Context` mixes true ctx members
 * with non-service fields (`root`, `baseUrl`, `logger`) that a blind walk would
 * wrongly surface as services, and (c) the internal/* events carry no JSDoc to
 * render. Source pointers are verified against vendor by `verify-md-links`'
 * sibling check is N/A; keep them current on a vendor bump.
 */
const INHERITED_EVENTS: InheritedEntry[] = [
  { name: 'internal/plugin', summary: 'A plugin fiber was created.', source: 'vendor/cordis/src/events.ts:197' },
  { name: 'internal/status', summary: 'A fiber changed lifecycle state.', source: 'vendor/cordis/src/events.ts:198' },
  { name: 'internal/service', summary: 'Interception hook for a service binding (no core producer).', source: 'vendor/cordis/src/events.ts:199' },
  { name: 'internal/update', summary: 'Waterfall: a fiber config update is being applied.', source: 'vendor/cordis/src/events.ts:200' },
  { name: 'internal/get', summary: 'Waterfall: a service is being read from the store.', source: 'vendor/cordis/src/events.ts:201' },
  { name: 'internal/set', summary: 'Waterfall: a service is being written to the store.', source: 'vendor/cordis/src/events.ts:202' },
  { name: 'internal/listener', summary: 'A listener was registered.', source: 'vendor/cordis/src/events.ts:203' },
  { name: 'internal/dispatch', summary: 'An event is being dispatched to listeners.', source: 'vendor/cordis/src/events.ts:204' },
  { name: 'hmr/change', summary: 'A watched source file changed on disk.', source: 'vendor/hmr/src/index.ts:20' },
  { name: 'hmr/reload', summary: 'Plugins are being reloaded after a change.', source: 'vendor/hmr/src/index.ts:21' },
  { name: 'exit', summary: 'The process is exiting on a signal.', source: 'vendor/loader/src/index.ts:23' },
  { name: 'loader/config-update', summary: 'The loader config tree changed.', source: 'vendor/loader/src/index.ts:24' },
  { name: 'loader/entry-init', summary: 'A config entry is being initialized.', source: 'vendor/loader/src/index.ts:25' },
  { name: 'loader/partial-dispose', summary: 'An entry is being partially disposed on reload.', source: 'vendor/loader/src/index.ts:26' },
  { name: 'loader/patch-context', summary: 'A context is being patched during a reload.', source: 'vendor/loader/src/index.ts:27' },
]

const INHERITED_SERVICES: InheritedEntry[] = [
  { name: 'ctx.on / ctx.once', summary: 'Register an event listener (disposable).', source: 'vendor/cordis/src/events.ts:29' },
  { name: 'ctx.emit / ctx.parallel / ctx.serial / ctx.bail / ctx.waterfall', summary: 'Dispatch an event (sync / awaited / first-non-nullish / veto-chain).', source: 'vendor/cordis/src/events.ts:29' },
  { name: 'ctx.plugin / ctx.inject', summary: 'Load a plugin / declare required services.', source: 'vendor/cordis/src/registry.ts:144' },
  { name: 'ctx.effect', summary: 'Register a disposable side effect tied to the fiber.', source: 'vendor/cordis/src/fiber.ts:9' },
  { name: 'ctx.get / ctx.set / ctx.provide / ctx.accessor / ctx.mixin', summary: 'Low-level service-store access and binding.', source: 'vendor/cordis/src/reflect.ts:7' },
  { name: 'ctx.extend / ctx.isolate / ctx.intercept', summary: 'Derive a child context (scoped services / isolation / interception).', source: 'vendor/cordis/src/context.ts:35' },
  { name: 'ctx.root / ctx.scope / ctx.fiber / ctx.registry / ctx.reflect / ctx.events / ctx.logger', summary: 'Ambient handles onto the running context graph.', source: 'vendor/cordis/src/context.ts:16' },
  { name: 'ctx.timer (+ interval / timeout / throttle / debounce / setTimeout / setInterval)', summary: 'Disposable timer helpers. The `timer` key is provided at runtime; the six helpers are mixed onto ctx directly (declared via Pick).', source: 'vendor/timer/src/index.ts:4' },
  { name: 'ctx.loader', summary: 'The config Loader that booted the app (present under the loader).', source: 'vendor/loader/src/index.ts:30' },
  { name: 'ctx.hmr', summary: 'The hot-module-reload watcher (present under the hmr plugin).', source: 'vendor/hmr/src/index.ts:15' },
]

/** Render the cross-link "Types:" line for a signature, or '' if none apply. */
function typeLinks(signature: string): string {
  const seen = new Set<string>()
  for (const name of Object.keys(LINK_MAP)) {
    if (new RegExp(`\\b${name}\\b`).test(signature)) seen.add(name)
  }
  if (seen.size === 0) return ''
  const links = [...seen].sort().map(n => `[${n}](../core-data-structures/${LINK_MAP[n]})`)
  return `Types: ${links.join(' · ')}`
}

/** Render one harness event entry. */
function renderEvent(e: EventEntry): string[] {
  const out = [`#### \`${e.name}\` — ${e.mode}`, '']
  if (e.doc) out.push(e.doc, '')
  out.push('```' + FENCE, e.signature, '```', '')
  const links = typeLinks(e.signature)
  if (links) out.push(links, '')
  out.push(`Source: [\`${e.source}\`](../../${e.source.split(':')[0]})`, '')
  return out
}

/** Render one harness service entry. */
function renderService(s: ServiceEntry): string[] {
  const kind = s.abstract ? ' (abstract seam)' : ''
  const out = [`### \`ctx.${s.key}\` — \`${s.type}\`${kind}`, '']
  if (s.doc) out.push(s.doc, '')
  if (s.methods.length) {
    out.push('```' + FENCE, ...s.methods, '```', '')
    const links = typeLinks(s.methods.join('\n'))
    if (links) out.push(links, '')
  }
  out.push(`Source: [\`${s.source}\`](../../${s.source.split(':')[0]})`, '')
  return out
}

/** Render the full catalog (pure, deterministic given sorted inputs). */
function render(events: EventEntry[], services: ServiceEntry[]): string {
  const lines: string[] = [
    '<!-- Generated by scripts/gen-cordis-catalog.ts — do not edit by hand.',
    '     Run `pnpm run gen-cordis-catalog` to regenerate. -->',
    '',
    '# Cordis Events & Services Catalog',
    '',
    'An index reference to the **wiring** a plugin author works against: every cordis event you can listen to (exact signature + dispatch mode) and every `ctx.<key>` service you can call (exact public interface). It complements [core-data-structures/](../core-data-structures/core.md), which catalogs the *data structures* these signatures move around — this page is the verbs, that page is the nouns.',
    '',
    'This file is GENERATED from source (`scripts/gen-cordis-catalog.ts`) and verified fresh by `pnpm run verify-cordis-catalog` (part of `doc-sync`) — do not edit it by hand. Signature blocks use a `ts cordis-catalog` fence (skipped by doc-typecheck, since a bare signature is not standalone-compilable). Type names in a signature link to the page that documents them.',
    '',
    'The **harness tier** below (the `@deepseek-ai/dsh-*` packages) is the vocabulary this repo owns. The **inherited tier** at the end is the cordis-core + loader/hmr/timer surface a plugin also sees — pinned vendor source, summarized tersely.',
    '',
    '## Events',
    '',
    `Dispatch modes: **emit** (fire-and-forget), **waterfall** (each listener gets \`next()\` and may transform or veto — see [waterfall semantics](../architecture.md#cordis-waterfall-semantics-important)), **parallel** (awaited fan-out, no veto). The harness declares ${events.length} events across ${new Set(events.map(e => e.scope)).size} scopes.`,
    '',
  ]
  const scopes = [...new Set(events.map(e => e.scope))].sort()
  for (const scope of scopes) {
    lines.push(`### \`${scope}/*\``, '')
    for (const e of events.filter(x => x.scope === scope).sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(...renderEvent(e))
    }
  }
  lines.push(
    '## Services',
    '',
    `The ${services.length} \`ctx.<key>\` services the harness provides. An abstract seam (e.g. \`ctx.bash\`) is implemented by a separate package; the interface is what consumers code against.`,
    '',
  )
  for (const s of services) lines.push(...renderService(s))
  lines.push(
    '## Inherited tier (cordis core + loader/hmr/timer)',
    '',
    'The framework surface every plugin inherits, beyond the harness vocabulary above. This is pinned vendor source ([vendoring policy](../../vendor/README.md)); it is summarized here so the catalog is a complete picture of what `ctx` and the event bus offer, without elevating framework internals to the harness tier\'s prominence.',
    '',
    '### Inherited events',
    '',
  )
  for (const e of INHERITED_EVENTS) {
    lines.push(`- \`${e.name}\` — ${e.summary} ([\`${e.source}\`](../../${e.source.split(':')[0]}))`)
  }
  lines.push('', '### Inherited `ctx` members', '')
  for (const s of INHERITED_SERVICES) {
    lines.push(`- \`${s.name}\` — ${s.summary} ([\`${s.source}\`](../../${s.source.split(':')[0]}))`)
  }
  lines.push('')
  return lines.join('\n')
}

/** CLI entry: `--write` (default) writes the catalog, `--check` fails if stale.
 * Guarded behind an entry-point check so importing this module for tests neither
 * regenerates the committed file nor calls process.exit. */
function main(): void {
  const content = render(collectEvents(), collectServices())
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
      console.log(`gen-cordis-catalog: ${OUT} is up to date.`)
      process.exit(0)
    }
    console.error(`gen-cordis-catalog: ${OUT} is stale. Run \`pnpm run gen-cordis-catalog\` and commit ${OUT}.`)
    process.exit(1)
  }

  writeFileSync(resolve(root, OUT), content)
  console.log(`gen-cordis-catalog: wrote ${OUT}.`)
}

// Run only when invoked as a script, not when imported by a test.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
