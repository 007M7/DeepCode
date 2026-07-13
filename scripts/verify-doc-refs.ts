/**
 * Verify root-relative `docs/*.md` tokens in repo-authored TypeScript. The
 * textual scan requires the extension, checks matching string literals too,
 * and excludes built declarations and vendored source.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** Repo-authored TypeScript that may cite docs in comments. */
const PATTERNS = ['packages/**/*.ts', 'examples/**/*.ts']

/** Paths excluded from the scan: built output and vendored upstream source. */
const isExcluded = (p: string): boolean =>
  p.includes('/lib/') || p.endsWith('.d.ts') || p.startsWith('vendor/')

/** Root-relative Markdown path token, excluding trailing prose. */
const DOC_REF = /\bdocs\/[A-Za-z0-9._/-]+\.md/g

/** A broken doc reference: a root-relative `docs/….md` token with no file. */
interface Violation {
  file: string
  /** 1-based line where the reference appears. */
  line: number
  ref: string
}

/** Find every broken `docs/….md` reference in one TypeScript file. */
function findViolations(absPath: string): Violation[] {
  const file = relative(root, absPath)
  const source = readFileSync(absPath, 'utf8')
  const out: Violation[] = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    for (const m of line.matchAll(DOC_REF)) {
      const ref = m[0]
      if (!existsSync(resolve(root, ref))) {
        out.push({ file, line: i + 1, ref })
      }
    }
  }
  return out
}

const all: Violation[] = []
let checked = 0
for (const pattern of PATTERNS) {
  for (const match of globSync(pattern, { cwd: root })) {
    if (isExcluded(match)) continue
    checked++
    all.push(...findViolations(resolve(root, match)))
  }
}

if (all.length === 0) {
  console.log(`verify-doc-refs: ${checked} file(s) checked, all docs/*.md references resolve.`)
  process.exit(0)
}

console.error('verify-doc-refs: broken docs/*.md references found in source comments (target does not exist):')
for (const v of all) {
  console.error(`  ${v.file}:${v.line}  ${v.ref}`)
}
process.exit(1)
