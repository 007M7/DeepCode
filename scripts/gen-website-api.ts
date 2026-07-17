/**
 * Generate (and verify) the website API reference under `website/zh-CN/api/`.
 *
 * The website's API section is FULLY GENERATED from source — never hand-edit
 * it. The hand-written hub `api/index.md` sits OUTSIDE the generated subdirs
 * (`api/cordis/`, `api/harness/`), so the orphan sweep never touches it. Two tiers:
 *
 * - `api/cordis/*` — the vendored cordis framework surface (Context, Events,
 *   Fiber, Registry, Service), driven by the CORDIS_PAGES manifest below.
 *   Members come from the real class declarations and the `declare module
 *   './context.ts'` interface merges (the typed `ctx.*` surface a plugin
 *   author actually sees).
 * - `api/harness/*` — one page per `ctx.<key>` harness service (walked from
 *   every `declare module 'cordis'` Context merge under `packages/<group>/<pkg>/src`),
 *   plus `events.md` listing every harness event grouped by scope.
 *
 * Prose comes from the JSDoc; the generator HARD-ERRORS (aggregated) when a
 * rendered member lacks a summary, a parameter lacks `@param`, or a non-void
 * annotated return lacks `@returns` — so a vendor sync or a new service method
 * cannot land undocumented without CI going red. Pages are English (the
 * planned zh translation flow arrives separately; see docs/i18n/README.md).
 *
 * Signature fences use the ` ```ts website-api ` info string: doc-typecheck
 * only processes its known info strings, so these bare (non-compilable)
 * signature fragments are skipped there, while VitePress still highlights the
 * `ts` token. The sidebar fragment `website/.vitepress/config/api-sidebar.json`
 * is generated alongside so navigation can never drift from the page set.
 *
 *   `tsx scripts/gen-website-api.ts`          → write pages + sidebar
 *   `tsx scripts/gen-website-api.ts --check`  → exit 1 if committed copies are
 *                                               stale (doc-sync / CI gate)
 */

import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import ts from 'typescript'
import { checkParams, checkReturns, parseJsDoc, parseTags, pointer, rawJsDoc, reportViolations, type Mode } from './jsdoc.ts'
import { cordisModuleBody, eventMembers, serviceClasses } from './cordis-walk.ts'

const root = resolve(import.meta.dirname, '..')

/** Output roots: generated pages and the generated sidebar fragment. */
const PAGES_DIR = 'website/zh-CN/api'
const SIDEBAR_OUT = 'website/.vitepress/config/api-sidebar.json'

/** GitHub blob base for source links on the public site (repo-relative paths
 * do not resolve on the built site, unlike the in-repo catalogs). */
const GITHUB = 'https://github.com/deepseek-harness/deepseek-harness/blob/master'

/** Signature-fence info string (skipped by doc-typecheck, highlighted as ts). */
const FENCE = 'ts website-api'

/** Return sorted repository-relative glob matches with stable URL separators. */
function repoGlob(pattern: string): string[] {
  return globSync(pattern, { cwd: root }).map(rel => rel.replaceAll('\\', '/')).sort()
}

/** One rendered member: a method/property plus its parsed JSDoc. */
interface MemberDoc {
  /** Display name, e.g. `on` or `agent/pre-step`. */
  name: string
  /** Heading suffix with parameter names, e.g. `(name, listener, options?)`;
   * empty for properties. */
  heading: string
  /** All overload signature lines (bodies stripped). */
  signatures: string[]
  /** Description prose, one paragraph per line. */
  doc: string
  /** Parameter name → `@param` text, in declaration order. */
  params: { name: string; text: string }[]
  /** `@returns` text, or null for void/undocumented. */
  returns: string | null
  /** Repo-relative `file:line` of the (first) declaration. */
  source: string
}

/** A cordis-page section: which declarations it renders. */
type Section =
  | { kind: 'class'; file: string; symbol: string; prefix?: string; heading?: string }
  | { kind: 'context-merge'; file: string; heading?: string }
  | { kind: 'decl'; file: string; symbol: string }

/** One generated cordis page. */
interface CordisPage {
  out: string
  title: string
  intro: string
  sections: Section[]
}

/**
 * The cordis tier manifest. Deliberately explicit (not a blind walk): the
 * vendor `Context` mixes true plugin-author surface with internals, and page
 * grouping is an editorial choice — but every member listed here is still
 * EXTRACTED, never transcribed, so signatures and docs cannot drift.
 */
const CORDIS_PAGES: CordisPage[] = [
  {
    out: 'cordis/context.md',
    title: 'Context',
    intro: 'The context is the core cordis object: every service, event, and lifecycle API is reached through `ctx`. Event methods (`ctx.on`, `ctx.emit`, …) are documented on [Events](./events.md); `ctx.effect` and `ctx.fiber` on [Fiber](./fiber.md); `ctx.plugin` and `ctx.inject` on [Registry](./registry.md).',
    sections: [
      { kind: 'class', file: 'vendor/cordis/src/context.ts', symbol: 'Context', prefix: 'ctx.' },
      { kind: 'context-merge', file: 'vendor/cordis/src/reflect.ts', heading: 'Service store and mixins' },
    ],
  },
  {
    out: 'cordis/events.md',
    title: 'Events',
    intro: 'The event system mixed into every context. Harness-defined events are cataloged on [Harness events](../harness/events.md).',
    sections: [
      { kind: 'context-merge', file: 'vendor/cordis/src/events.ts' },
      { kind: 'decl', file: 'vendor/cordis/src/events.ts', symbol: 'EventOptions' },
      { kind: 'decl', file: 'vendor/cordis/src/events.ts', symbol: 'DispatchMode' },
    ],
  },
  {
    out: 'cordis/fiber.md',
    title: 'Fiber',
    intro: 'A fiber is one loaded plugin instance: its lifecycle state, validated config, and registered effects. `ctx.fiber` is the current fiber; `ctx.effect()` delegates to it.',
    sections: [
      { kind: 'context-merge', file: 'vendor/cordis/src/fiber.ts' },
      { kind: 'class', file: 'vendor/cordis/src/fiber.ts', symbol: 'Fiber', heading: 'The Fiber class' },
      { kind: 'decl', file: 'vendor/cordis/src/fiber.ts', symbol: 'Effect' },
      { kind: 'decl', file: 'vendor/cordis/src/fiber.ts', symbol: 'Disposable' },
      { kind: 'decl', file: 'vendor/cordis/src/fiber.ts', symbol: 'EffectMeta' },
      { kind: 'decl', file: 'vendor/cordis/src/fiber.ts', symbol: 'CordisError' },
      { kind: 'decl', file: 'vendor/cordis/src/fiber.ts', symbol: 'ValidationError' },
    ],
  },
  {
    out: 'cordis/registry.md',
    title: 'Registry',
    intro: 'Plugin loading and dependency injection.',
    sections: [
      { kind: 'context-merge', file: 'vendor/cordis/src/registry.ts' },
      { kind: 'decl', file: 'vendor/cordis/src/registry.ts', symbol: 'Plugin' },
      { kind: 'decl', file: 'vendor/cordis/src/registry.ts', symbol: 'Inject' },
    ],
  },
  {
    out: 'cordis/service.md',
    title: 'Service',
    intro: 'Base class for context services: subclass it and load the subclass as a plugin to register `ctx.<name>`.',
    sections: [
      { kind: 'class', file: 'vendor/cordis/src/service.ts', symbol: 'Service' },
    ],
  },
]
// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

const sfCache = new Map<string, { sf: ts.SourceFile; text: string }>()

/** Parse (and cache) one repo-relative source file. */
function load(rel: string): { sf: ts.SourceFile; text: string } {
  const cached = sfCache.get(rel)
  if (cached) return cached
  const text = readFileSync(resolve(root, rel), 'utf8')
  const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true)
  const entry = { sf, text }
  sfCache.set(rel, entry)
  return entry
}
// The module-merge walk (cordisModuleBody / eventMembers / serviceClasses) is
// shared with gen-cordis-catalog.ts via cordis-walk.ts.

/** Signature text of a member: full text minus body/initializer, whitespace
 * collapsed, trailing semicolon stripped. */
function signatureOf(member: ts.Node, sf: ts.SourceFile): string {
  const full = member.getText(sf)
  const tail = (member as { body?: ts.Node; initializer?: ts.Node }).body
    ?? (member as { initializer?: ts.Node }).initializer
  const sig = tail ? full.slice(0, full.length - tail.getText(sf).length).replace(/[=\s]+$/, '') : full
  return sig.replace(/\s*;?\s*$/, '').replace(/\s+/g, ' ').trim()
}

/** `(a, b?, ...rest)` heading suffix from a parameter list, `this` dropped. */
function headingParams(parameters: readonly ts.ParameterDeclaration[], sf: ts.SourceFile): string {
  const names = parameters
    .filter(p => !(ts.isIdentifier(p.name) && p.name.text === 'this'))
    .map((p) => {
      const dots = p.dotDotDotToken ? '...' : ''
      const opt = p.questionToken || p.initializer ? '?' : ''
      return `${dots}${p.name.getText(sf)}${opt}`
    })
  return `(${names.join(', ')})`
}

/** Whether a class member is renderable public API (non-static half). */
function isPublicInstance(member: ts.ClassElement): boolean {
  const mods = ts.getCombinedModifierFlags(member)
  if (mods & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected | ts.ModifierFlags.Static)) return false
  if (!member.name) return false
  if (ts.isComputedPropertyName(member.name) || ts.isPrivateIdentifier(member.name)) return false
  return !member.name.getText().startsWith('_')
}

/** Whether a class member is renderable public STATIC API. */
function isPublicStatic(member: ts.ClassElement): boolean {
  const mods = ts.getCombinedModifierFlags(member)
  if (mods & (ts.ModifierFlags.Private | ts.ModifierFlags.Protected)) return false
  if (!(mods & ts.ModifierFlags.Static)) return false
  if (!member.name || ts.isComputedPropertyName(member.name) || ts.isPrivateIdentifier(member.name)) return false
  return !member.name.getText().startsWith('_')
}

/** Build a MemberDoc from a declaration group (overloads share one entry),
 * collecting completeness violations for everything rendered. */
function memberDoc(
  where: string,
  name: string,
  group: (ts.MethodDeclaration | ts.MethodSignature | ts.PropertyDeclaration | ts.PropertySignature | ts.GetAccessorDeclaration)[],
  rel: string,
  violations: string[],
): MemberDoc {
  const { sf, text } = load(rel)
  const first = group[0]
  if (!first) throw new Error(`gen-website-api: empty member group for ${name}`)
  // Doc from the first overload that carries JSDoc prose.
  const rawDocs = group.map(m => rawJsDoc(text, m))
  const docIndex = rawDocs.findIndex(r => parseJsDoc(r).doc !== '')
  const raw = docIndex === -1 ? '' : (rawDocs[docIndex] ?? '')
  const doc = parseJsDoc(raw).doc
  if (!doc) violations.push(`${where} has no JSDoc prose.`)
  const { params: tags, returns } = parseTags(raw)
  const params: { name: string; text: string }[] = []
  let returnsText: string | null = null
  const funcLike = group.filter((m): m is ts.MethodDeclaration | ts.MethodSignature => ts.isMethodDeclaration(m) || ts.isMethodSignature(m))
  const docCarrier = funcLike[docIndex === -1 ? 0 : docIndex]
  if (docCarrier) {
    checkParams(where, 'website-api', docCarrier.parameters, tags, sf,
      p => ts.isIdentifier(p.name) && p.name.text === 'this', violations)
    if (docCarrier.type) {
      checkReturns(where, docCarrier.type, returns, sf, violations)
    } else if (!returns && ts.isMethodDeclaration(docCarrier)) {
      // Comment-only vendor policy: we cannot add a return type annotation to
      // pinned upstream source, so an unannotated rendered method must carry
      // an explicit @returns describing the result instead.
      violations.push(`${where} has no return type annotation; document the result with @returns.`)
    }
    for (const p of docCarrier.parameters) {
      if (ts.isIdentifier(p.name) && p.name.text === 'this') continue
      const pname = p.name.getText(sf)
      const tag = tags.get(pname)
      if (tag) params.push({ name: pname, text: tag })
    }
    returnsText = returns
  }
  const headingSource = docCarrier ?? funcLike[0]
  return {
    name,
    heading: headingSource ? headingParams(headingSource.parameters, sf) : '',
    signatures: (ts.isMethodDeclaration(first) && funcLike.length > 1
      ? funcLike.filter(m => ts.isMethodDeclaration(m) && !m.body)
      : group).map(m => signatureOf(m, sf)),
    doc,
    params,
    returns: returnsText,
    source: pointer(rel, sf, first),
  }
}

/** Resolve an `extends Pick<Class, 'a' | 'b'>` heritage clause on the Context
 * merge to the named members of `Class` declared in the same file — the fiber
 * merge (`interface Context extends Pick<Fiber, 'effect'>`) is the motivating
 * case: without this, `ctx.effect` had no documented signature anywhere. */
function heritageMembers(
  stmt: ts.InterfaceDeclaration,
  sf: ts.SourceFile,
  groups: Map<string, (ts.MethodSignature | ts.PropertySignature | ts.MethodDeclaration)[]>,
): void {
  for (const clause of stmt.heritageClauses ?? []) {
    for (const type of clause.types) {
      if (!ts.isIdentifier(type.expression) || type.expression.text !== 'Pick') continue
      const [target, keys] = type.typeArguments ?? []
      if (!target || !keys || !ts.isTypeReferenceNode(target)) continue
      const targetName = target.typeName.getText(sf)
      const cls = sf.statements.find(
        (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === targetName,
      )
      if (!cls) continue
      const picked = new Set<string>()
      const collect = (node: ts.TypeNode): void => {
        if (ts.isLiteralTypeNode(node) && ts.isStringLiteral(node.literal)) picked.add(node.literal.text)
        if (ts.isUnionTypeNode(node)) node.types.forEach(collect)
      }
      collect(keys)
      for (const member of cls.members) {
        if (!ts.isMethodDeclaration(member)) continue
        const name = member.name.getText(sf)
        if (!picked.has(name)) continue
        const group = groups.get(name) ?? []
        group.push(member)
        groups.set(name, group)
      }
    }
  }
}

/** Members of the `interface Context` merge in `rel`, overloads grouped;
 * `Pick<…>` heritage resolved to the picked class members. */
function contextMergeMembers(rel: string, violations: string[]): MemberDoc[] {
  const { sf } = load(rel)
  const body = cordisModuleBody(sf)
  if (!body) throw new Error(`gen-website-api: ${rel} has no context module merge`)
  const groups = new Map<string, (ts.MethodSignature | ts.PropertySignature | ts.MethodDeclaration)[]>()
  for (const stmt of body.statements) {
    if (!ts.isInterfaceDeclaration(stmt) || stmt.name.text !== 'Context') continue
    heritageMembers(stmt, sf, groups)
    for (const member of stmt.members) {
      if (!ts.isMethodSignature(member) && !ts.isPropertySignature(member)) continue
      if (ts.isComputedPropertyName(member.name)) continue
      const name = member.name.getText(sf)
      const group = groups.get(name) ?? []
      group.push(member)
      groups.set(name, group)
    }
  }
  return [...groups.entries()].map(([name, group]) =>
    memberDoc(`ctx.${name} (${rel})`, name, group, rel, violations))
}

/** Instance + static members of one class, as two rendered lists. The class's
 * same-named top-level interface half (declaration merging — vendor Context
 * declares `root`/`events`/`logger`/… on the interface) is folded into the
 * instance list, so neither half of a merged symbol goes undocumented. */
function classMembers(rel: string, className: string, violations: string[]): {
  doc: string
  instance: MemberDoc[]
  statics: MemberDoc[]
  source: string
} {
  const { sf, text } = load(rel)
  const cls = sf.statements.find(
    (s): s is ts.ClassDeclaration => ts.isClassDeclaration(s) && s.name?.text === className,
  )
  if (!cls) throw new Error(`gen-website-api: class ${className} not found in ${rel}`)
  const clsDoc = parseJsDoc(rawJsDoc(text, cls)).doc
  if (!clsDoc) violations.push(`class ${className} (${pointer(rel, sf, cls)}) has no JSDoc.`)
  type Renderable = ts.MethodDeclaration | ts.PropertyDeclaration | ts.GetAccessorDeclaration | ts.PropertySignature
  const instance = new Map<string, Renderable[]>()
  const statics = new Map<string, (ts.MethodDeclaration | ts.PropertyDeclaration)[]>()
  for (const member of cls.members) {
    const renderable = ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member)
    if (!renderable) continue
    const name = member.name.getText(sf)
    if (isPublicInstance(member)) {
      const group = instance.get(name) ?? []
      group.push(member)
      instance.set(name, group)
    } else if (isPublicStatic(member) && !ts.isGetAccessorDeclaration(member)) {
      const group = statics.get(name) ?? []
      group.push(member)
      statics.set(name, group)
    }
  }
  const iface = sf.statements.find(
    (s): s is ts.InterfaceDeclaration => ts.isInterfaceDeclaration(s) && s.name.text === className,
  )
  for (const member of iface?.members ?? []) {
    if (!ts.isPropertySignature(member)) continue
    if (ts.isComputedPropertyName(member.name)) continue
    const name = member.name.getText(sf)
    const group = instance.get(name) ?? []
    group.push(member)
    instance.set(name, group)
  }
  const toDocs = (groups: Map<string, Renderable[]>, prefix: string): MemberDoc[] =>
    [...groups.entries()].map(([name, group]) =>
      memberDoc(`${prefix}${name} (${rel})`, name, group, rel, violations))
  return {
    doc: clsDoc,
    instance: toDocs(instance, `${className}#`),
    statics: toDocs(statics, `${className}.`),
    source: pointer(rel, sf, cls),
  }
}

/** Splice every function-like BODY out of a declaration's text, leaving the
 * signature (`) {` → `)`). A reference paste shows shapes, not implementation;
 * property initializers (e.g. an `as const` code table) are data and stay. */
function stripBodies(node: ts.Node, sf: ts.SourceFile): string {
  const cuts: { start: number; end: number }[] = []
  const visit = (n: ts.Node): void => {
    const funcLike = ts.isMethodDeclaration(n) || ts.isConstructorDeclaration(n)
      || ts.isFunctionDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)
    if (funcLike && n.body) {
      // Cut from just after the parameter close (or return-type end) through
      // the body, so `foo(a: string) { … }` renders as `foo(a: string)`.
      const sigEnd = (n.type ?? n.parameters[n.parameters.length - 1] ?? n).getEnd()
      // Find the `)` (and optional `: Type`) boundary: body start is exact.
      cuts.push({ start: sigEnd, end: n.body.getEnd() })
      return // nothing renderable inside the body
    }
    n.forEachChild(visit)
  }
  visit(node)
  const base = node.getStart(sf)
  let out = node.getText(sf)
  for (const cut of cuts.sort((a, b) => b.start - a.start)) {
    const head = out.slice(0, cut.start - base)
    // Keep everything of the signature up to the closing paren / return type,
    // drop ` { … }`. The head may end mid-signature (last param), so retain
    // the source between sigEnd and the body's `{` MINUS trailing space.
    const between = out.slice(cut.start - base, cut.end - base)
    const bodyBrace = between.indexOf('{')
    out = head + between.slice(0, bodyBrace).trimEnd() + out.slice(cut.end - base)
  }
  return out
}

/** Verbatim declaration paste: every top-level statement named `symbol`
 * (class + merged namespace both), with leading JSDoc prose extracted and
 * function bodies stripped (a reference shows shapes, not implementation). */
function declPaste(rel: string, symbol: string): { doc: string; code: string; source: string } {
  const { sf, text } = load(rel)
  const matches = sf.statements.filter((s) => {
    const named = ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)
      || ts.isClassDeclaration(s) || ts.isEnumDeclaration(s) || ts.isModuleDeclaration(s)
    return named && s.name?.getText(sf) === symbol
  })
  if (matches.length === 0) throw new Error(`gen-website-api: declaration ${symbol} not found in ${rel}`)
  const first = matches[0]
  if (!first) throw new Error(`gen-website-api: declaration ${symbol} not found in ${rel}`)
  const doc = parseJsDoc(rawJsDoc(text, first)).doc
  const code = matches.map(s => stripBodies(s, sf).replace(/^export\s+(default\s+)?/, '')).join('\n\n')
  return { doc, code, source: pointer(rel, sf, first) }
}

/** One harness service with member-level detail. */
interface HarnessService {
  key: string
  type: string
  abstract: boolean
  doc: string
  members: MemberDoc[]
  source: string
  /** Owning npm package name (from the package.json beside the entry). */
  pkg: string
}

/** Walk every harness `declare module 'cordis'` Context merge → services. */
function collectHarnessServices(violations: string[]): HarnessService[] {
  const services: HarnessService[] = []
  for (const rel of repoGlob('packages/*/*/src/index.ts')) {
    const { sf, text } = load(rel)
    if (!text.includes('interface Context')) continue
    const body = cordisModuleBody(sf)
    if (!body) continue
    const pkgJson = resolve(root, dirname(dirname(rel)), 'package.json')
    // Manifest shape is repo-owned; `name` is the one field read here.
    const manifest = JSON.parse(readFileSync(pkgJson, 'utf8')) as { name: string }
    const pkg = manifest.name
    for (const { key, type, cls, abstract, doc: clsDoc } of serviceClasses(body, sf, rel, violations)) {
      const groups = new Map<string, (ts.MethodDeclaration | ts.PropertyDeclaration | ts.GetAccessorDeclaration)[]>()
      for (const member of cls.members) {
        // Public properties are API too: ctx.codeRuntime.language/isolation
        // are readonly descriptors consumers key presentation off.
        const renderable = ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member) || ts.isGetAccessorDeclaration(member)
        if (!renderable) continue
        if (!isPublicInstance(member)) continue
        const name = member.name.getText(sf)
        const group = groups.get(name) ?? []
        group.push(member)
        groups.set(name, group)
      }
      const members = [...groups.entries()].map(([name, group]) =>
        memberDoc(`ctx.${key}.${name} (${rel})`, name, group, rel, violations))
      services.push({ key, type, abstract, doc: clsDoc, members, source: pointer(rel, sf, cls), pkg })
    }
  }
  return services.sort((a, b) => a.key.localeCompare(b.key))
}

/** One harness event with member-level detail. */
interface HarnessEvent {
  name: string
  scope: string
  mode: Mode | null
  signature: string
  doc: string
  params: { name: string; text: string }[]
  source: string
}

/** Walk every harness `interface Events` merge → events. */
function collectHarnessEvents(violations: string[]): HarnessEvent[] {
  const events: HarnessEvent[] = []
  for (const rel of repoGlob('packages/*/*/src/*.ts')) {
    const { sf, text } = load(rel)
    if (!text.includes('interface Events')) continue
    const body = cordisModuleBody(sf)
    if (!body) continue
    for (const { name, member } of eventMembers(body, sf)) {
      const raw = rawJsDoc(text, member)
      const { doc, mode } = parseJsDoc(raw)
      if (!mode) violations.push(`event '${name}' (${pointer(rel, sf, member)}) is missing @mode.`)
      if (!doc) violations.push(`event '${name}' (${pointer(rel, sf, member)}) has no JSDoc prose.`)
      const { params: tags } = parseTags(raw)
      const last = member.parameters.at(-1)
      const hasNext = !!last && last.name.getText(sf) === 'next'
      checkParams(`event '${name}' (${pointer(rel, sf, member)})`, 'website-api', member.parameters, tags, sf,
        p => (ts.isIdentifier(p.name) && p.name.text === 'this') || (hasNext && p === last), violations)
      const params: { name: string; text: string }[] = []
      for (const p of member.parameters) {
        const pname = p.name.getText(sf)
        const tag = tags.get(pname)
        if (tag) params.push({ name: pname, text: tag })
      }
      events.push({ name, scope: name.split('/')[0] ?? name, mode, signature: signatureOf(member, sf), doc, params, source: pointer(rel, sf, member) })
    }
  }
  return events.sort((a, b) => a.name.localeCompare(b.name))
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const BANNER = '<!-- Generated by scripts/gen-website-api.ts — do not edit by hand. Run `pnpm run gen-website-api` to regenerate. -->'

/** GitHub source link for a `file:line` pointer. */
function sourceLink(source: string): string {
  const [file, line] = source.split(':')
  return `[Source](${GITHUB}/${file}#L${line})`
}

/** Normalize JSDoc inline `{@link X}` / `{@link X|label}` / `{@link X label}`
 * tags to plain Markdown code spans — left verbatim they leak into the built
 * page as literal `{@link …}` text. */
function unlink(text: string): string {
  return text.replace(/\{@link\s+([^}|\s]+)\s*(?:[|\s]\s*([^}]*))?\}/g, (_m, target: string, label?: string) => {
    const name = label?.trim()
    return name && name !== '' ? name : `\`${target}\``
  })
}

/** Render prose paragraphs (one per line of `doc`), JSDoc links normalized. */
function prose(doc: string): string[] {
  return unlink(doc).split('\n').filter(l => l.trim() !== '')
}

/** Render one member section at heading depth 3. */
function renderMember(prefix: string, m: MemberDoc): string[] {
  const lines: string[] = []
  const call = m.heading === '' ? '' : m.heading
  lines.push(`### ${prefix}${m.name}${call}`, '')
  lines.push('```' + FENCE)
  for (const sig of m.signatures) lines.push(sig)
  lines.push('```', '')
  lines.push(...prose(m.doc), '')
  if (m.params.length > 0) {
    for (const p of m.params) lines.push(`- \`${p.name}\` — ${unlink(p.text)}`)
    lines.push('')
  }
  if (m.returns) lines.push(`**Returns** ${unlink(m.returns)}`, '')
  lines.push(sourceLink(m.source), '')
  return lines
}

/** Render one cordis-tier page from its manifest entry. */
function renderCordisPage(page: CordisPage, violations: string[]): string {
  const lines: string[] = [BANNER, '', `# ${page.title}`, '', page.intro, '']
  for (const section of page.sections) {
    if (section.kind !== 'decl' && section.heading) lines.push(`## ${section.heading}`, '')
    if (section.kind === 'context-merge') {
      for (const m of contextMergeMembers(section.file, violations)) {
        lines.push(...renderMember('ctx.', m))
      }
    } else if (section.kind === 'class') {
      const cls = classMembers(section.file, section.symbol, violations)
      lines.push(...prose(cls.doc), '', sourceLink(cls.source), '')
      const instancePrefix = section.prefix ?? `${section.symbol.toLowerCase()}.`
      for (const m of cls.instance) lines.push(...renderMember(instancePrefix, m))
      if (cls.statics.length > 0) {
        lines.push('## Static members', '')
        for (const m of cls.statics) lines.push(...renderMember(`${section.symbol}.`, m))
      }
    } else {
      const decl = declPaste(section.file, section.symbol)
      lines.push(`## ${section.symbol}`, '')
      if (decl.doc) lines.push(...prose(decl.doc), '')
      lines.push('```' + FENCE, decl.code, '```', '', sourceLink(decl.source), '')
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/** kebab-case a ctx key: `agentLoop` → `agent-loop`. */
function kebab(key: string): string {
  return key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)
}

/** Render one harness service page. */
function renderServicePage(svc: HarnessService): string {
  const seam = svc.abstract ? ' (abstract seam)' : ''
  const lines: string[] = [
    BANNER, '',
    `# ctx.${svc.key}`, '',
    `\`${svc.type}\`${seam} — provided by \`${svc.pkg}\`.`, '',
    ...prose(svc.doc), '',
    sourceLink(svc.source), '',
  ]
  for (const m of svc.members) lines.push(...renderMember(`ctx.${svc.key}.`, m))
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

/** Render the harness events page, grouped by scope. */
function renderEventsPage(events: HarnessEvent[]): string {
  const lines: string[] = [
    BANNER, '',
    '# Harness events', '',
    `Every event the harness packages declare on the cordis event bus (${events.length} total), grouped by scope. The **mode** is the dispatch semantics (\`emit\` fire-and-forget, \`parallel\` awaited, \`serial\` first-bail, \`waterfall\` veto-chain — a waterfall listener MUST call \`next()\` to delegate).`, '',
  ]
  const scopes = [...new Set(events.map(e => e.scope))].sort()
  for (const scope of scopes) {
    lines.push(`## ${scope}/*`, '')
    for (const e of events.filter(ev => ev.scope === scope)) {
      lines.push(`### ${e.name}`, '')
      lines.push(`**Mode:** \`${e.mode ?? 'unknown'}\``, '')
      lines.push('```' + FENCE, e.signature, '```', '')
      lines.push(...prose(e.doc), '')
      if (e.params.length > 0) {
        for (const p of e.params) lines.push(`- \`${p.name}\` — ${unlink(p.text)}`)
        lines.push('')
      }
      lines.push(sourceLink(e.source), '')
    }
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`
}

// ---------------------------------------------------------------------------
// Assembly + CLI
// ---------------------------------------------------------------------------

/** Build every generated file as `relPath → content`. */
export function generate(): Map<string, string> {
  const violations: string[] = []
  const files = new Map<string, string>()

  for (const page of CORDIS_PAGES) {
    files.set(`${PAGES_DIR}/${page.out}`, renderCordisPage(page, violations))
  }

  const services = collectHarnessServices(violations)
  for (const svc of services) {
    files.set(`${PAGES_DIR}/harness/${kebab(svc.key)}.md`, renderServicePage(svc))
  }

  const events = collectHarnessEvents(violations)
  files.set(`${PAGES_DIR}/harness/events.md`, renderEventsPage(events))

  reportViolations('gen-website-api', violations)

  const sidebar = {
    cordis: CORDIS_PAGES.map(p => ({
      text: p.title,
      link: `/zh-CN/api/${p.out.replace(/\.md$/, '')}`,
    })),
    harness: [
      ...services.map(s => ({ text: `ctx.${s.key}`, link: `/zh-CN/api/harness/${kebab(s.key)}` })),
      { text: 'Events', link: '/zh-CN/api/harness/events' },
    ],
  }
  files.set(SIDEBAR_OUT, `${JSON.stringify(sidebar, null, 2)}\n`)
  return files
}

/** CLI entry: default writes, `--check` fails on stale/orphan files. Guarded
 * behind an entry-point check so tests can import `generate()`. */
function main(): void {
  const check = process.argv.includes('--check')
  const files = generate()

  // Orphan detection: a generated-dir page that generate() no longer emits
  // (e.g. a service was renamed) must be deleted, not left to rot.
  const expected = new Set([...files.keys()])
  // Orphans live in the generated subdirs only; the hand-written api/index.md
  // is one level up and never matches this glob.
  const onDisk = repoGlob(`${PAGES_DIR}/{cordis,harness}/*.md`)
  const orphans = onDisk.filter(rel => !expected.has(rel))

  if (check) {
    const stale: string[] = []
    for (const [rel, content] of files) {
      let current: string | null = null
      try {
        current = readFileSync(resolve(root, rel), 'utf8')
      } catch {
        // Missing file: reported as stale below; readFileSync is the probe.
      }
      if (current !== content) stale.push(rel)
    }
    if (stale.length > 0 || orphans.length > 0) {
      console.error('gen-website-api: website API reference is stale. Run `pnpm run gen-website-api` and commit the result.')
      for (const rel of stale) console.error(`  stale: ${rel}`)
      for (const rel of orphans) console.error(`  orphan (delete): ${rel}`)
      process.exit(1)
    }
    console.log(`gen-website-api: ${files.size} generated file(s) fresh.`)
    return
  }

  for (const [rel, content] of files) {
    const abs = resolve(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    writeFileSync(abs, content)
  }
  for (const rel of orphans) {
    console.log(`gen-website-api: orphan page ${rel} — delete it (no longer generated).`)
  }
  console.log(`gen-website-api: wrote ${files.size} file(s).`)
}

// Run only when invoked as a script, not when imported by a test.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
