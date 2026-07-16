/**
 * Typecheck Markdown `ts` fences against workspace sources. `ignore-check`
 * fences are reported as opt-outs; generated catalog fragments and
 * `type-equiv` blocks are skipped here because their owning gates verify them.
 */

import { execFileSync } from 'node:child_process'
import { globSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { extractFences } from './md-fences.ts'

const root = resolve(import.meta.dirname, '..')

/**
 * TypeScript-fence ownership. `check` compiles; `ignore` is an unchecked sketch
 * counted in the opt-out ratio; the catalog and type-equivalence variants are
 * excluded from that ratio because their owning gates verify them.
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

/** The info-string → kind table this gate tracks. */
const KIND_BY_INFO: Record<string, BlockKind> = {
  'ts': 'check',
  'ts ignore-check': 'ignore',
  'ts type-equiv': 'type-equiv',
  'ts cordis-catalog': 'cordis-catalog',
  'ts persistence-catalog': 'persistence-catalog',
  'ts config-catalog': 'config-catalog',
}

/** Extract every recognized TypeScript fence from one Markdown file. */
function extractBlocks(absPath: string): Block[] {
  const file = relative(root, absPath)
  return extractFences(absPath, info => KIND_BY_INFO[info] ?? null)
    .map(f => ({ file, line: f.line, kind: f.kind, code: f.code }))
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

const markdownGlobs = ['README.md', 'docs/**/*.md', 'packages/*/*.md', 'packages/*/*/*.md', 'website/zh-CN/**/*.md']

const files: string[] = []
for (const pattern of markdownGlobs) {
  for (const match of globSync(pattern, { cwd: root })) files.push(resolve(root, match))
}
files.sort()

const all = files.flatMap(extractBlocks)
const checked = all.filter(b => b.kind === 'check')
const ignored = all.filter(b => b.kind === 'ignore')
// Only compile-eligible fences belong in the opt-out ratio; every other skipped
// kind has an independent verifier named in BlockKind's contract above.
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
    // tsc's JS entry via the current node, not the .bin shim: the extensionless
    // shim is not spawnable on Windows (the CVE-2024-27980 class the sibling
    // scripts hit), and the .cmd variant would need shell:true, which
    // concatenates args UNESCAPED — a hazard for the temp project path. The JS
    // entry behaves identically on every platform.
    execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-b', join(tmp, 'tsconfig.json')], { cwd: root, stdio: 'pipe' })
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
