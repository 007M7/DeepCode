/**
 * Doc-sync gate (doc-sync-enforcement RFC, part 1): typecheck the fenced `ts` code blocks in our
 * Markdown so documentation can't drift from the API it documents.
 *
 * Every ```ts block in README.md, docs/** and packages/* /README.md is
 * extracted to a temp typecheck project and compiled against the workspace
 * sources through the same project-reference boundaries used by repo
 * typecheck. A block that is a deliberate sketch rather than compilable code
 * opts out with an explicit ` ```ts ignore-check ` info string — the opt-out
 * is visible in the source, and this script reports the ratio so the escape
 * hatch can't quietly become the norm. A third info string,
 * doc-typecheck.ts recognizes four more fence variants and skips all four (each
 * is a separately-checked category, not an unchecked sketch, so none counts in
 * the opt-out ratio): ` ```ts type-equiv ` is a verbatim source-type paste that
 * `scripts/verify-type-equiv.ts` drift-checks, ` ```ts cordis-catalog ` is a
 * generated event/service signature fragment in the cordis catalog (a bare
 * signature is not standalone-compilable; the catalog is generated and frozen by
 * `scripts/gen-cordis-catalog.ts` + its `--check` freshness gate),
 * ` ```ts persistence-catalog ` is a generated log-event payload fragment in the
 * persistence catalog (same reasoning, frozen by `scripts/gen-persistence-catalog.ts`),
 * and ` ```ts config-catalog ` is a generated verbatim config declaration in the
 * plugin config catalog (same reasoning, frozen by `scripts/gen-config-catalog.ts`).
 *
 * Run: `tsx scripts/doc-typecheck.ts`.
 */

import { execFileSync } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'

const root = resolve(import.meta.dirname, '..')

/**
 * How a fenced block participates in this gate:
 * - `check` (` ```ts `) — compiled.
 * - `ignore` (` ```ts ignore-check `) — a deliberate sketch; skipped, and
 *   counted in the opt-out ratio so the escape hatch can't quietly take over.
 * - `type-equiv` (` ```ts type-equiv `) — a verbatim paste of a source type
 *   definition, drift-checked by `scripts/verify-type-equiv.ts` against the
 *   source symbol. Skipped HERE (it is not standalone-compilable — no imports)
 *   and EXCLUDED from the opt-out ratio: it is a separate fully-checked
 *   category, not an unchecked sketch.
 * - `cordis-catalog` (` ```ts cordis-catalog `) — a generated event/service
 *   signature fragment in the cordis catalog. Skipped HERE for the same reason
 *   (a bare signature fragment has no imports and does not stand alone) and
 *   EXCLUDED from the opt-out ratio: the catalog is generated and frozen by
 *   `scripts/gen-cordis-catalog.ts` + its `--check` freshness gate.
 * - `persistence-catalog` (` ```ts persistence-catalog `) — a generated
 *   log-event payload fragment in the persistence catalog. Same treatment for
 *   the same reason; frozen by `scripts/gen-persistence-catalog.ts` + its
 *   `--check` freshness gate.
 * - `config-catalog` (` ```ts config-catalog `) — a generated verbatim config
 *   declaration in the plugin config catalog (a lone declaration referencing
 *   imported types does not stand alone). Same treatment for the same reason;
 *   frozen by `scripts/gen-config-catalog.ts` + its `--check` freshness gate.
 */
type BlockKind = 'check' | 'ignore' | 'type-equiv' | 'cordis-catalog' | 'persistence-catalog' | 'config-catalog'

/** One extracted code block. */
interface Block {
  file: string
  /** 1-based line of the opening fence. */
  line: number
  kind: BlockKind
  code: string
}

/** Extract every ts / ts ignore-check / ts type-equiv / ts cordis-catalog /
 * ts persistence-catalog / ts config-catalog block from one Markdown file. */
function extractBlocks(absPath: string): Block[] {
  const text = readFileSync(absPath, 'utf8')
  const lines = text.split('\n')
  const file = relative(root, absPath)
  const blocks: Block[] = []
  let open: { line: number; kind: BlockKind; body: string[] } | null = null

  lines.forEach((raw, i) => {
    const fence = /^```(\s*)(\S.*)?$/.exec(raw)
    if (!fence) {
      if (open) open.body.push(raw)
      return
    }
    if (open) {
      // closing fence
      blocks.push({ file, line: open.line, kind: open.kind, code: open.body.join('\n') })
      open = null
      return
    }
    // opening fence — only care about ts blocks
    const info = (fence[2] ?? '').trim()
    const kind: BlockKind | null =
      info === 'ts' ? 'check'
        : info === 'ts ignore-check' ? 'ignore'
          : info === 'ts type-equiv' ? 'type-equiv'
            : info === 'ts cordis-catalog' ? 'cordis-catalog'
              : info === 'ts persistence-catalog' ? 'persistence-catalog'
                : info === 'ts config-catalog' ? 'config-catalog'
                  : null
    if (kind) open = { line: i + 1, kind, body: [] }
  })
  return blocks
}

/** Reuse the repo typecheck graph references from a temp project one directory below root. */
function workspaceReferences(): { path: string }[] {
  const file = join(root, 'tsconfig.json')
  // Parse with TypeScript's own JSONC reader, not a hand-rolled comment strip:
  // a regex strip mistakes the `/*/` in a wildcard path candidate
  // (`./packages/core/*/src`) for a block comment and corrupts the map.
  const result = ts.readConfigFile(file, p => readFileSync(p, 'utf8'))
  if (result.error) {
    throw new Error(`doc-typecheck: cannot read ${file}: ${ts.flattenDiagnosticMessageText(result.error.messageText, '\n')}`)
  }
  // `config` is typed `any` by the TS API; narrow it to the one field we read.
  const { references } = result.config as { compilerOptions: { paths: Record<string, string[]> }; references: { path: string }[] }
  return references.map(({ path }) => {
    const relativeToTemp = path.startsWith('./') ? `../${path.slice(2)}` : `../${path}`
    return { path: relativeToTemp }
  })
}

/** The standalone tsconfig for the temp typecheck project. */
function tempTsconfig(): string {
  return JSON.stringify({
    extends: '../tsconfig.json',
    compilerOptions: {
      noUnusedLocals: false,
      noUnusedParameters: false,
      tsBuildInfoFile: './tsconfig.tsbuildinfo',
    },
    include: ['block-*.ts'],
    references: workspaceReferences(),
  })
}

const markdownGlobs = ['README.md', 'docs/**/*.md', 'packages/*/*.md', 'packages/*/*/*.md']

const files: string[] = []
for (const pattern of markdownGlobs) {
  for (const match of globSync(pattern, { cwd: root })) files.push(resolve(root, match))
}
files.sort()

const all = files.flatMap(extractBlocks)
const checked = all.filter(b => b.kind === 'check')
const ignored = all.filter(b => b.kind === 'ignore')
// `type-equiv`, `cordis-catalog`, and `persistence-catalog` blocks are verified
// elsewhere (verify-type-equiv.ts and each catalog generator's `--check`
// freshness gate), not here: neither compiled nor counted toward the opt-out
// ratio (each is a separate fully-checked category, not an unchecked sketch).
// The ratio's denominator is therefore the compile-eligible blocks only.
const ratioDenominator = checked.length + ignored.length

if (checked.length === 0) {
  console.log('doc-typecheck: no ts code blocks to check.')
  process.exit(0)
}

const tmp = mkdtempSync(join(root, '.doc-typecheck-'))
try {
  writeFileSync(join(tmp, 'tsconfig.json'), tempTsconfig())
  const fileForBlock = new Map<string, Block>()
  checked.forEach((block, i) => {
    const name = `block-${i}.ts`
    writeFileSync(join(tmp, name), block.code.endsWith('\n') ? block.code : `${block.code}\n`)
    fileForBlock.set(name, block)
  })

  try {
    execFileSync('node_modules/.bin/tsc', ['-b', join(tmp, 'tsconfig.json')], { cwd: root, stdio: 'pipe' })
  } catch (error: unknown) {
    const failed = error as { stdout?: Buffer; stderr?: Buffer }
    const out = `${failed.stdout?.toString() ?? ''}${failed.stderr?.toString() ?? ''}`
    // Rewrite "block-N.ts(line,col)" to the real "file:fenceLine" for triage.
    const remapped = out.replace(/(?:[^\s:()]*[/\\])?block-(\d+)\.ts\((\d+),(\d+)\)/g, (_m, idx: string, ln: string, col: string) => {
      const block = fileForBlock.get(`block-${idx}.ts`)
      if (!block) return `block-${idx}.ts(${ln},${col})`
      return `${block.file} (block at line ${block.line}, +${ln}:${col})`
    })
    console.error('doc-typecheck: documentation code blocks failed to compile.\n')
    console.error(remapped)
    process.exit(1)
  }

  const ratio = ignored.length / ratioDenominator
  const skipped = all.length - ratioDenominator
  console.log(`doc-typecheck: ${checked.length} block(s) compiled, ${ignored.length} ignored (${(ratio * 100).toFixed(0)}% opt-out), ${skipped} type-equiv/catalog (checked elsewhere).`)
  // Guard against the escape hatch becoming the norm.
  if (ratioDenominator >= 4 && ratio > 0.5) {
    console.error(`doc-typecheck: too many blocks opt out of checking (${ignored.length}/${ratioDenominator}). Make them compile or delete them.`)
    process.exit(1)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
