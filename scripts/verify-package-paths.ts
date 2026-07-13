/**
 * Find stale root-relative `packages/...` references in repo-authored prose and
 * TypeScript. A missing path is reported only when it names a real package leaf;
 * globs, placeholders, hypothetical packages, and unbuilt `lib/` output are
 * outside the check.
 */

import { existsSync, globSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

/** Markdown + repo-authored TypeScript that may cite package paths. */
const PATTERNS = [
  'README.md',
  'docs/**/*.md',
  'packages/*/*.md',
  'packages/*/*/*.md',
  'AGENTS.md',
  'packages/AGENTS.md',
  'packages/**/*.ts',
  'examples/**/*.ts',
]

/** Paths excluded from the scan: built output and vendored upstream source. */
const isExcluded = (p: string): boolean =>
  p.includes('/lib/') || p.endsWith('.d.ts') || p.startsWith('vendor/')

/**
 * Directory names of every real package, `packages/<group>/<pkg>`. A broken
 * reference is only flagged when one of its segments is in this set — that is
 * what scopes the gate to DRIFT (a moved real package) rather than typos or
 * not-yet-existing packages named in a proposal.
 */
function realPackageNames(): Set<string> {
  const names = new Set<string>()
  const pkgRoot = resolve(root, 'packages')
  for (const group of readdirSync(pkgRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    for (const pkg of readdirSync(resolve(pkgRoot, group.name), { withFileTypes: true })) {
      if (pkg.isDirectory()) names.add(pkg.name)
    }
  }
  return names
}

const packageNames = realPackageNames()

/**
 * Match a `packages/<path>` reference token. The character class is plain path
 * characters only, so a glob (`*`), placeholder (`<`, `>`), or brace expansion
 * (`{`, `}`, `,`) terminates the match before those chars and is never probed —
 * those are patterns, not real paths. A trailing `.`/`/` (e.g. a sentence-ending
 * period) is trimmed before the existence check.
 */
const PKG_REF = /\bpackages\/[A-Za-z0-9._/-]+/g

/** A broken package reference: a stale root-relative `packages/…` path. */
interface Violation {
  file: string
  /** 1-based line where the reference appears. */
  line: number
  ref: string
}

/**
 * Find every DRIFTED `packages/…` reference in one file: a token that does not
 * resolve on disk AND names a real package in one of its segments (so it is a
 * moved path, not a typo or a not-yet-existing package). The same real-package
 * test also screens out a bare `packages` (no segment) and illustrative
 * skeletons whose segment is not a package.
 */
function findViolations(absPath: string): Violation[] {
  const file = relative(root, absPath)
  const source = readFileSync(absPath, 'utf8')
  const out: Violation[] = []
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    for (const m of line.matchAll(PKG_REF)) {
      // Trim a trailing path separator or sentence punctuation that the greedy
      // class may have swallowed (`packages/core/tools.` / `…/tools/`).
      const ref = m[0].replace(/[./]+$/, '')
      if (existsSync(resolve(root, ref))) continue
      // Skip unbuilt `lib/` only below a real depth-two package root. A stale
      // group-less path still fails; `lib` is not a blanket escape hatch.
      const parts = ref.split('/')
      const libAt = parts.indexOf('lib')
      if (libAt === 3 && existsSync(resolve(root, parts.slice(0, 3).join('/')))) continue
      // Only a stale path to a REAL (moved) package is a violation; a segment
      // matching a live package name is the drift signal.
      const segments = ref.split('/').slice(1)
      if (segments.some(seg => packageNames.has(seg))) {
        out.push({ file, line: i + 1, ref })
      }
    }
  }
  return out
}

const all: Violation[] = []
let checked = 0
const seen = new Set<string>()
for (const pattern of PATTERNS) {
  for (const match of globSync(pattern, { cwd: root })) {
    if (isExcluded(match)) continue
    // Dedup by real path: the root/packages CLAUDE.md are symlinks to AGENTS.md.
    const real = realpathSync(resolve(root, match))
    if (seen.has(real)) continue
    seen.add(real)
    checked++
    all.push(...findViolations(real))
  }
}

if (all.length === 0) {
  console.log(`verify-package-paths: ${checked} file(s) checked, all packages/* references resolve.`)
  process.exit(0)
}

console.error('verify-package-paths: broken packages/* references found (target does not exist):')
for (const v of all) {
  console.error(`  ${v.file}:${v.line}  ${v.ref}`)
}
process.exit(1)
