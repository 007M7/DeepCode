/**
 * Generate (and verify) the runtime cordis API catalog the `cordis_inspect`
 * tool serves to the model: packages/cordis/tool-cordis/src/api-catalog.ts.
 *
 * The artifact is the machine-readable sibling of docs/cordis-catalog: it
 * reuses `collectServices` / `collectEvents` from `gen-cordis-catalog.ts` (the
 * same JSDoc-completeness-enforcing AST walk), so the API the model reads at
 * runtime and the API the docs render cannot diverge. Emitted as a typed
 * TypeScript data module (not JSON): it compiles under the package tsconfig,
 * passes lint and the export-JSDoc gate, and is trivially covered by import.
 *
 * The data is trimmed for a model-facing text surface: per service the
 * `ctx.<key>` name, the first sentence of the class doc, and the raw method
 * signatures; per event the name, `@mode`, signature, and first sentence of
 * doc; the SHAPES of every exported interface/type-alias the service
 * signatures reference (transitively — so a model can see that e.g. a
 * `BashRunResult.stdout` is `{ text, truncated }`, not a string); plus the
 * curated inherited `ctx` surface shared with the docs catalog. Source
 * pointers are dropped (a `file:line` means nothing to the model) and entries
 * are sorted deterministically.
 *
 *   `tsx scripts/gen-cordis-api.ts`          → write the artifact
 *   `tsx scripts/gen-cordis-api.ts --check`  → exit 1 if the committed file is
 *                                              stale (CI / pre-push gate)
 */

import { globSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import ts from 'typescript'
import { collectEvents, collectServices, INHERITED_SERVICES } from './gen-cordis-catalog.ts'

const root = resolve(import.meta.dirname, '..')
const OUT = 'packages/cordis/tool-cordis/src/api-catalog.ts'

/** Declarations longer than this render as a truncated stub — a shape the model cannot skim teaches nothing. */
const MAX_DECL_CHARS = 1500

/** The first sentence of a (possibly multi-line) JSDoc prose block. */
function firstSentence(doc: string): string {
  const line = doc.split('\n', 1)[0] ?? ''
  const match = /^(.*?[.!?])(?:\s|$)/.exec(line)
  return (match?.[1] ?? line).trim()
}

/** Render a string as a single-quoted, lint-clean TS literal. */
function quote(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, '\\\'').replace(/\n/g, '\\n')}'`
}

/**
 * Every exported `interface` / `type` declaration under `packages/<group>/<pkg>/src`,
 * printed without comments, keyed by name. A name declared in more than one
 * package (e.g. each plugin's `Config`) is ambiguous and dropped entirely —
 * serving the wrong package's shape is worse than serving none.
 */
function collectTypeDecls(scanRoot: string = root): Map<string, string> {
  const printer = ts.createPrinter({ removeComments: true })
  const decls = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const rel of globSync('packages/*/*/src/*.ts', { cwd: scanRoot }).sort()) {
    const abs = resolve(scanRoot, rel)
    const sf = ts.createSourceFile(abs, readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true)
    for (const stmt of sf.statements) {
      if (!ts.isInterfaceDeclaration(stmt) && !ts.isTypeAliasDeclaration(stmt)) continue
      if (!(stmt.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) ?? false)) continue
      const name = stmt.name.text
      if (decls.has(name)) {
        ambiguous.add(name)
        continue
      }
      const printed = printer.printNode(ts.EmitHint.Unspecified, stmt, sf).replace(/\r/g, '')
      decls.set(name, printed.length > MAX_DECL_CHARS
        ? `${printed.slice(0, MAX_DECL_CHARS)} /* …truncated — full shape in source */`
        : printed)
    }
  }
  for (const name of ambiguous) decls.delete(name)
  return decls
}

/**
 * The transitive closure of type names referenced by the seed texts: every
 * collected declaration whose name appears (word-bounded) in a seed or in an
 * already-included declaration, sorted by name.
 */
function referencedTypes(seeds: string[], decls: Map<string, string>): { name: string; declaration: string }[] {
  const included = new Map<string, string>()
  let frontier = seeds
  while (frontier.length > 0) {
    const next: string[] = []
    for (const [name, declaration] of decls) {
      if (included.has(name)) continue
      const pattern = new RegExp(`\\b${name}\\b`)
      if (frontier.some(text => pattern.test(text))) {
        included.set(name, declaration)
        next.push(declaration)
      }
    }
    frontier = next
  }
  return [...included].map(([name, declaration]) => ({ name, declaration })).sort((a, b) => a.name.localeCompare(b.name))
}

/** Render the whole generated module (pure, deterministic given sorted collector output). */
function render(): string {
  const services = collectServices()
  const events = collectEvents().sort((a, b) => a.name.localeCompare(b.name))
  const types = referencedTypes(services.flatMap(service => service.methods), collectTypeDecls())
  const lines: string[] = [
    '/**',
    ' * Generated by scripts/gen-cordis-api.ts — do not edit by hand; run',
    ' * `pnpm run gen-cordis-api` to regenerate (freshness-gated by',
    ' * `pnpm run verify-cordis-api` in doc-sync).',
    ' *',
    ' * The machine-readable cordis API catalog `cordis_inspect` serves to the',
    ' * model: harness services (summary + public method signatures), harness',
    ' * events (mode + signature), and the inherited `ctx` surface. Produced by',
    ' * the same AST walk as docs/cordis-catalog, so this data and the rendered',
    ' * docs cannot diverge.',
    ' *',
    ' * @module @deepseek-ai/dsh-tool-cordis/api-catalog',
    ' */',
    '',
    '/** One harness `ctx.<key>` service: its one-line summary and public method signatures. */',
    'export interface ServiceApiEntry {',
    '  /** The `ctx.<key>` name, e.g. `tools`. */',
    '  key: string',
    '  /** First sentence of the service class JSDoc. */',
    '  summary: string',
    '  /** Public method signatures, bodies stripped, in source order. */',
    '  methods: readonly string[]',
    '}',
    '',
    '/** One harness event: its dispatch mode, exact signature, and one-line summary. */',
    'export interface EventApiEntry {',
    '  /** The scoped event name, e.g. `agent/status`. */',
    '  name: string',
    '  /** The dispatch mode from the declaration\'s `@mode` tag. */',
    '  mode: string',
    '  /** The exact listener signature, whitespace-normalized. */',
    '  signature: string',
    '  /** First sentence of the event JSDoc. */',
    '  summary: string',
    '}',
    '',
    '/** One inherited (cordis core + loader/hmr/timer) `ctx` member group with its summary. */',
    'export interface InheritedApiEntry {',
    '  /** The `ctx` member name(s), e.g. `ctx.on / ctx.once`. */',
    '  name: string',
    '  /** One-line summary of what the member does. */',
    '  summary: string',
    '}',
    '',
    '/** One named type shape the service signatures reference. */',
    'export interface TypeApiEntry {',
    '  /** The exported type/interface name, e.g. `BashRunResult`. */',
    '  name: string',
    '  /** The full declaration text, comments stripped. */',
    '  declaration: string',
    '}',
    '',
    '/** Every harness `ctx.<key>` service, sorted by key. */',
    'export const SERVICE_API: readonly ServiceApiEntry[] = [',
  ]
  for (const service of services) {
    lines.push('  {')
    lines.push(`    key: ${quote(service.key)},`)
    lines.push(`    summary: ${quote(firstSentence(service.doc))},`)
    if (service.methods.length === 0) {
      lines.push('    methods: [],')
    } else {
      lines.push('    methods: [')
      for (const method of service.methods) lines.push(`      ${quote(method)},`)
      lines.push('    ],')
    }
    lines.push('  },')
  }
  lines.push(
    ']',
    '',
    '/** Every harness event, sorted by name. */',
    'export const EVENT_API: readonly EventApiEntry[] = [',
  )
  for (const event of events) {
    lines.push('  {')
    lines.push(`    name: ${quote(event.name)},`)
    lines.push(`    mode: ${quote(event.mode)},`)
    lines.push(`    signature: ${quote(event.signature)},`)
    lines.push(`    summary: ${quote(firstSentence(event.doc))},`)
    lines.push('  },')
  }
  lines.push(
    ']',
    '',
    '/** Shapes of every exported type the SERVICE_API signatures reference (transitively), sorted by name. */',
    'export const TYPE_API: readonly TypeApiEntry[] = [',
  )
  for (const type of types) {
    lines.push('  {')
    lines.push(`    name: ${quote(type.name)},`)
    lines.push(`    declaration: ${quote(type.declaration)},`)
    lines.push('  },')
  }
  lines.push(
    ']',
    '',
    '/** The inherited `ctx` surface (cordis core + loader/hmr/timer), in curated order. */',
    'export const INHERITED_CTX_API: readonly InheritedApiEntry[] = [',
  )
  for (const inherited of INHERITED_SERVICES) {
    lines.push(`  { name: ${quote(inherited.name)}, summary: ${quote(inherited.summary)} },`)
  }
  lines.push(']', '')
  return lines.join('\n')
}

/** CLI entry: default writes the artifact, `--check` fails if the committed
 * copy is stale. Guarded behind an entry-point check so importing this module
 * for tests neither regenerates the committed file nor calls process.exit. */
function main(): void {
  const content = render()
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
      console.log(`gen-cordis-api: ${OUT} is up to date.`)
      process.exit(0)
    }
    console.error(`gen-cordis-api: ${OUT} is stale. Run \`pnpm run gen-cordis-api\` and commit ${OUT}.`)
    process.exit(1)
  }

  writeFileSync(resolve(root, OUT), content)
  console.log(`gen-cordis-api: wrote ${OUT}.`)
}

// Run only when invoked as a script, not when imported by a test.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  main()
}
