/**
 * Doc-sync gate: catch DRIFTED `packages/<path>` references — a path to a
 * package that has MOVED, written as prose in Markdown or in a TypeScript
 * comment/string. Docs and comments cite package locations by root-relative
 * path (`packages/core/tools/src/index.ts`, `see packages/ui/acp`);
 * `verify-md-links` only parses Markdown LINK targets and `verify-doc-refs`
 * only checks `docs/*.md` tokens, so a `packages/…` path sitting in backtick
 * prose or a code comment goes unchecked. The package-hierarchy reorg is the
 * motivating case: it moved every package under a `{group}/` folder, so a stale
 * `packages/tools` (now `packages/core/tools`) reads fine to a human but points
 * at nothing.
 *
 * The check is drift-scoped, NOT a blanket existence test: a broken
 * `packages/<path>` token is a violation ONLY when one of its path segments is
 * the directory name of a package that actually exists on disk — i.e. the
 * package is real and the path is merely stale. A token naming a package that
 * exists NOWHERE (`packages/code-runtime` in a forward-looking proposal, an
 * illustrative `packages/<name>/` skeleton) is left alone: this gate reports
 * MOVED paths, not hypothetical or future ones, so it applies uniformly to
 * proposed/implemented/rejected docs without per-lifecycle exclusions. This is
 * checker, not fixer: it reports and never rewrites.
 *
 * Detection is a token scan, NOT an AST walk: package refs live in free prose,
 * backticks, and comments. We match `packages/<path>` tokens whose path is made
 * of plain path characters, so a glob, a `<placeholder>`, or a `{brace,expansion}`
 * terminates the match before those chars and is never probed.
 *
 * Scope mirrors the other doc gates plus repo-authored TypeScript: Markdown
 * across README/docs/packages/AGENTS, and `.ts` under packages/** and
 * examples/** (excluding built `lib/`, `*.d.ts`, and vendored upstream source).
 * A reference to a package's build OUTPUT (`packages/<group>/<pkg>/lib/…`,
 * e.g. `packages/ui/acp-agent/lib/bin.js` cited by a built-bin smoke) is also
 * skipped — it is emitted only by `pnpm run build`, which CI runs AFTER this
 * gate, so flagging it would be a false positive on a path that is correct but
 * not yet on disk. That skip is scoped to a REAL package root: a stale
 * group-less `packages/acp-agent/lib/bin.js` is still flagged (its root does not
 * exist — exactly the moved-package drift this gate catches).
 *
 * Run: `tsx scripts/verify-package-paths.ts`.
 */

import { existsSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { findReferenceViolations, uniqueRepoFiles, type ReferenceViolation as Violation } from './repo-files.ts'

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

function isDriftedPackageReference(ref: string): boolean {
  if (existsSync(resolve(root, ref))) return false
  // A reference INTO a package's built `lib/` is a build OUTPUT, not an
  // authored-source location: it does not exist until `pnpm run build` emits
  // it, and CI runs this gate BEFORE the build step. Skip it — but ONLY when
  // the `packages/<group>/<pkg>` ROOT it sits under is real and on disk, so
  // `packages/ui/acp-agent/lib/bin.js` (correct, just not yet built) is
  // exempt while a stale `packages/acp-agent/lib/bin.js` (group-less, the
  // exact moved-package drift this gate exists to catch) still flags. A bare
  // `lib` segment is not a blanket escape hatch.
  const parts = ref.split('/')
  const libAt = parts.indexOf('lib')
  if (libAt === 3 && existsSync(resolve(root, parts.slice(0, 3).join('/')))) return false
  // Only a stale path to a REAL (moved) package is a violation; a segment
  // matching a live package name is the drift signal.
  return ref.split('/').slice(1).some(segment => packageNames.has(segment))
}

/**
 * Find every DRIFTED `packages/…` reference in one file: a token that does not
 * resolve on disk AND names a real package in one of its segments (so it is a
 * moved path, not a typo or a not-yet-existing package). The same real-package
 * test also screens out a bare `packages` (no segment) and illustrative
 * skeletons whose segment is not a package.
 */
function findViolations(absPath: string): Violation[] {
  return findReferenceViolations(
    root,
    absPath,
    PKG_REF,
    // Trim a trailing path separator or sentence punctuation that the greedy
    // class may have swallowed (`packages/core/tools.` / `…/tools/`).
    ref => ref.replace(/[./]+$/, ''),
    isDriftedPackageReference,
  )
}

const files = uniqueRepoFiles(root, PATTERNS, isExcluded)
const all = files.flatMap(file => findViolations(file.real))
const checked = files.length

if (all.length === 0) {
  console.log(`verify-package-paths: ${checked} file(s) checked, all packages/* references resolve.`)
  process.exit(0)
}

console.error('verify-package-paths: broken packages/* references found (target does not exist):')
for (const v of all) {
  console.error(`  ${v.file}:${v.line}  ${v.ref}`)
}
process.exit(1)
