/**
 * Doc-sync gate (RFC 006 part 1): typecheck the fenced `ts` code blocks in our
 * Markdown so documentation can't drift from the API it documents.
 *
 * Every ```ts block in README.md, docs/** and packages/* /README.md is
 * extracted to a temp file and compiled with `tsc --noEmit` against the
 * workspace sources (resolved through the same `paths` map vitest uses, so no
 * build is required first). A block that is a deliberate sketch rather than
 * compilable code opts out with an explicit ` ```ts ignore-check ` info string
 * — the opt-out is visible in the source, and this script reports the ratio so
 * the escape hatch can't quietly become the norm.
 *
 * Run: `tsx scripts/doc-typecheck.ts`.
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { glob } from 'node:fs/promises'

const root = resolve(import.meta.dirname, '..')

/** One extracted code block. */
interface Block {
  file: string
  /** 1-based line of the opening fence. */
  line: number
  /** `true` when the fence is ` ```ts ignore-check ` (skip compilation). */
  ignored: boolean
  code: string
}

/** Extract every ```ts / ```ts ignore-check block from one Markdown file. */
function extractBlocks(absPath: string): Block[] {
  const text = readFileSync(absPath, 'utf8')
  const lines = text.split('\n')
  const file = relative(root, absPath)
  const blocks: Block[] = []
  let open: { line: number; ignored: boolean; body: string[] } | null = null

  lines.forEach((raw, i) => {
    const fence = /^```(\s*)(\S.*)?$/.exec(raw)
    if (!fence) {
      if (open) open.body.push(raw)
      return
    }
    if (open) {
      // closing fence
      blocks.push({ file, line: open.line, ignored: open.ignored, code: open.body.join('\n') })
      open = null
      return
    }
    // opening fence — only care about ts blocks
    const info = (fence[2] ?? '').trim()
    if (info === 'ts' || info === 'ts ignore-check') {
      open = { line: i + 1, ignored: info === 'ts ignore-check', body: [] }
    }
  })
  return blocks
}

/**
 * Read the workspace `paths` map from tsconfig.typecheck.json (JSONC). This map
 * resolves vendored packages to their BUILT declarations (`lib`) and harness
 * packages to source (`src`) — the same resolution `yarn lint`/`typecheck` use.
 * Resolving vendor to `lib` (not `src`) is essential: otherwise tsc type-checks
 * raw vendor source and floods the run with unrelated errors. Requires the
 * vendor `lib/` to exist (a fresh clone runs `yarn build` first; CI does too).
 */
function workspacePaths(): Record<string, string[]> {
  const raw = readFileSync(join(root, 'tsconfig.typecheck.json'), 'utf8')
  // Strip // line comments and /* */ block comments so JSON.parse accepts it.
  const stripped = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
  return (JSON.parse(stripped) as { compilerOptions: { paths: Record<string, string[]> } })
    .compilerOptions.paths
}

/** The standalone tsconfig for the temp project (copies base resolution, no
 * composite/declaration settings that would fight `--noEmit`). */
function tempTsconfig(): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'es2024',
      module: 'esnext',
      moduleResolution: 'bundler',
      allowImportingTsExtensions: true,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: ['node'],
      baseUrl: root,
      ignoreDeprecations: '6.0',
      paths: workspacePaths(),
    },
  })
}

const markdownGlobs = ['README.md', 'docs/**/*.md', 'packages/*/README.md']

const files: string[] = []
for (const pattern of markdownGlobs) {
  for await (const match of glob(pattern, { cwd: root })) files.push(resolve(root, match))
}
files.sort()

const all = files.flatMap(extractBlocks)
const checked = all.filter(b => !b.ignored)
const ignored = all.filter(b => b.ignored)

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
    execFileSync('node_modules/.bin/tsc', ['-p', join(tmp, 'tsconfig.json')], { cwd: root, stdio: 'pipe' })
  } catch (error: unknown) {
    const out = (error as { stdout?: Buffer }).stdout?.toString() ?? ''
    // Rewrite "block-N.ts(line,col)" to the real "file:fenceLine" for triage.
    const remapped = out.replace(/block-(\d+)\.ts\((\d+),(\d+)\)/g, (_m, idx: string, ln: string, col: string) => {
      const block = fileForBlock.get(`block-${idx}.ts`)
      if (!block) return `block-${idx}.ts(${ln},${col})`
      return `${block.file} (block at line ${block.line}, +${ln}:${col})`
    })
    console.error('doc-typecheck: documentation code blocks failed to compile.\n')
    console.error(remapped)
    process.exit(1)
  }

  const ratio = ignored.length / all.length
  console.log(`doc-typecheck: ${checked.length} block(s) compiled, ${ignored.length} ignored (${(ratio * 100).toFixed(0)}% opt-out).`)
  // Guard against the escape hatch becoming the norm.
  if (all.length >= 4 && ratio > 0.5) {
    console.error(`doc-typecheck: too many blocks opt out of checking (${ignored.length}/${all.length}). Make them compile or delete them.`)
    process.exit(1)
  }
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
