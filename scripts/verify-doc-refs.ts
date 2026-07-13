/**
 * Doc-sync gate: verify that doc references written in TypeScript COMMENTS
 * resolve to a file that exists. Source comments cite docs by root-relative
 * prose path — `see docs/rfc/implemented/testing/2026-06-19-acp-snapshot-tests.md`,
 * `docs/architecture.md § Where New Behavior Goes`. `verify-md-links` parses Markdown
 * link AST and never sees these, so a doc rename or move could silently orphan
 * a `.ts` comment that points at it. The RFC classification reorg
 * ([the classification RFC](../docs/rfc/implemented/process/2026-06-20-rfc-classification.md))
 * is the motivating case: it moved every RFC under a `{class}/` folder, and
 * several `.ts` doc comments cite RFC paths that changed.
 *
 * Detection is a token scan, NOT an AST walk: doc refs live in free prose inside
 * comments, not in a structured form. We match `docs/<path>.md` tokens and
 * REQUIRE the `.md` extension, so extensionless prose (`docs/postmortem/0001`,
 * `docs/architecture.md § Where New Behavior Goes` — the section suffix is outside the
 * token) is left alone rather than misread as a path. Each token is resolved
 * ROOT-RELATIVE (the way the comments are written) and must exist on disk. This
 * is checker, not fixer: it reports and never rewrites.
 *
 * Scope is repo-authored TypeScript under `packages/**` and `examples/**`,
 * excluding built output (`lib/`, `*.d.ts`) and `vendor/` (pinned upstream
 * source we do not own). The scan is purely textual, so it does not distinguish
 * a token in a comment from one in a string literal — a `docs/….md` string in
 * code is checked too, which is harmless (such a path should resolve anyway).
 *
 * Run: `tsx scripts/verify-doc-refs.ts`.
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { findReferenceViolations, uniqueRepoFiles, type ReferenceViolation as Violation } from './repo-files.ts'

const root = resolve(import.meta.dirname, '..')

/** Repo-authored TypeScript that may cite docs in comments. */
const PATTERNS = ['packages/**/*.ts', 'examples/**/*.ts']

/** Paths excluded from the scan: built output and vendored upstream source. */
const isExcluded = (p: string): boolean =>
  p.includes('/lib/') || p.endsWith('.d.ts') || p.startsWith('vendor/')

/**
 * Match a `docs/…​.md` reference token. The `.md` extension is required so a
 * bare `docs/postmortem/0001` (no extension) does not register as a path. The
 * character class stops at whitespace, backticks, parens, and the section sign,
 * so trailing prose (`… .md § Where New Behavior Goes`) is not swallowed into the path.
 */
const DOC_REF = /\bdocs\/[A-Za-z0-9._/-]+\.md/g

/** Find every broken `docs/….md` reference in one TypeScript file. */
function findViolations(absPath: string): Violation[] {
  return findReferenceViolations(root, absPath, DOC_REF, ref => ref, ref => !existsSync(resolve(root, ref)))
}

const files = uniqueRepoFiles(root, PATTERNS, isExcluded)
const all = files.flatMap(file => findViolations(file.abs))
const checked = files.length

if (all.length === 0) {
  console.log(`verify-doc-refs: ${checked} file(s) checked, all docs/*.md references resolve.`)
  process.exit(0)
}

console.error('verify-doc-refs: broken docs/*.md references found in source comments (target does not exist):')
for (const v of all) {
  console.error(`  ${v.file}:${v.line}  ${v.ref}`)
}
process.exit(1)
