/**
 * Doc-sync gate: verify that every relative Markdown cross-link resolves to a
 * file that exists. Docs in this repo link to each other by relative path
 * (`[topic](../implemented/2026-…-….md)`, `[the cookbook](adding-a-tool.md)`);
 * a rename or a move silently breaks those links, and nothing caught it before
 * review. The RFC tree reorganization (one `docs/rfc/` with proposed/
 * implemented/ rejected/ subfolders, every file renamed to a dated slug) is the
 * motivating case: ~40 inter-doc links were rewritten by hand, and a single
 * fat-fingered path would have shipped a dead link.
 *
 * Detection is AST-based, mirroring verify-md-wrap: parse each file with
 * mdast-util-from-markdown + GFM, then walk every `link`, `image`, and
 * `definition` node. A target is checked when it is a RELATIVE path; these are
 * skipped because they are not ours to verify:
 *   - absolute URLs with a scheme (`https:`, `http:`, `mailto:`, …),
 *   - protocol-relative URLs (`//host/path`),
 *   - root-absolute paths (`/foo` — no stable base in a repo checkout),
 *   - pure in-page anchors (`#section`).
 * For a relative target the `#fragment` and `?query` are stripped, the path is
 * resolved against the linking file's directory, and the result must exist on
 * disk. This is checker, not fixer: it reports and never rewrites.
 *
 * Scope is the other doc-sync gates' set plus the two AGENTS.md files AND the
 * repo-authored agent-skill Markdown under `.agents/skills/` — those skill
 * files cross-link into the docs tree (e.g. the dsh-code-review skill cites the
 * RFC index), so a rename must not silently break them either: README.md,
 * docs/** /*.md, packages/* /README.md, AGENTS.md, packages/AGENTS.md,
 * .agents/skills/** /*.md. The root and packages/ CLAUDE.md are symlinks to the
 * AGENTS.md files, so they are deduped by real path.
 *
 * Run: `tsx scripts/verify-md-links.ts`.
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { glob } from 'node:fs/promises'
import { fromMarkdown } from 'mdast-util-from-markdown'
import { gfmFromMarkdown } from 'mdast-util-gfm'
import { gfm } from 'micromark-extension-gfm'
import type { Nodes } from 'mdast'

const root = resolve(import.meta.dirname, '..')

/**
 * Files to check: doc-typecheck's scope, the AGENTS.md pair, and repo-authored
 * agent-skill Markdown (which this repo's own docs reorg rewrites links in).
 */
const PATTERNS = [
  'README.md',
  'docs/**/*.md',
  'packages/*/*.md',
  'AGENTS.md',
  'packages/AGENTS.md',
  '.agents/skills/**/*.md',
]

/** A broken relative link: a target path that does not resolve to a file. */
interface Violation {
  file: string
  /** 1-based line where the link/image/definition node starts. */
  line: number
  url: string
}

/**
 * True for targets this gate must NOT check: scheme-qualified URLs (`https:`,
 * `mailto:`, …), protocol-relative (`//host`), root-absolute (`/path`), and
 * pure in-page anchors (`#frag`). Everything else is a relative path we own.
 */
function isExternalOrAnchor(url: string): boolean {
  if (url.startsWith('#')) return true
  if (url.startsWith('//')) return true
  if (url.startsWith('/')) return true
  // A scheme like `https:` / `mailto:` — a colon before any slash, dot, or hash.
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)
}

/**
 * Strip the `#fragment` and `?query` from a link target, then percent-decode
 * the remaining path so an encoded target (`My%20File.md`, `READ%4DE.md`)
 * probes the real filename on disk, the way a Markdown renderer resolves it. A
 * malformed escape (`%zz`) makes `decodeURIComponent` throw; we keep the raw
 * path in that case so the link is reported as broken (a `%zz` target is not a
 * file anyone meant to link) rather than crashing the gate.
 */
function pathPart(url: string): string {
  const raw = url.replace(/[#?].*$/, '')
  try {
    return decodeURIComponent(raw)
  } catch {
    // decodeURIComponent throws only on a malformed percent-escape; the raw
    // string is then a path no renderer resolves, so fall through to the
    // existence check, which reports it broken.
    return raw
  }
}

/** Find every broken relative cross-link in one Markdown file via its AST. */
function findViolations(absPath: string): Violation[] {
  const file = relative(root, absPath)
  const dir = dirname(absPath)
  const source = readFileSync(absPath, 'utf8')
  const tree = fromMarkdown(source, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] })
  const out: Violation[] = []

  const check = (url: string, node: Nodes): void => {
    if (isExternalOrAnchor(url)) return
    const target = pathPart(url)
    // A bare `#anchor` reduced to empty path is a same-file anchor — skip.
    if (target === '') return
    const resolved = resolve(dir, target)
    if (!existsSync(resolved)) {
      out.push({ file, line: node.position?.start.line ?? 0, url })
    }
  }

  const visit = (node: Nodes): void => {
    if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && 'url' in node) {
      check(node.url, node)
    }
    if ('children' in node) {
      for (const child of node.children) visit(child)
    }
  }
  visit(tree)
  return out
}

const seen = new Set<string>()
const all: Violation[] = []
let checked = 0
for (const pattern of PATTERNS) {
  for await (const match of glob(pattern, { cwd: root })) {
    const abs = resolve(root, match)
    // CLAUDE.md symlinks resolve onto AGENTS.md; dedupe by real path so a file
    // matched twice (or via symlink) is checked once.
    const real = realpathSync(abs)
    if (seen.has(real)) continue
    seen.add(real)
    checked++
    all.push(...findViolations(abs))
  }
}

if (all.length === 0) {
  console.log(`verify-md-links: ${checked} file(s) checked, all relative cross-links resolve.`)
  process.exit(0)
}

console.error('verify-md-links: broken relative cross-links found (target does not exist):')
for (const v of all) {
  console.error(`  ${v.file}:${v.line}  ${v.url}`)
}
process.exit(1)
