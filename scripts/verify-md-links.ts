/**
 * Verify that relative Markdown links, images, and definitions resolve — the
 * target file must exist AND a `#fragment` onto a Markdown target (including
 * a same-file `#anchor`) must name a real heading slug or explicit `<a id>`.
 * URL and root-absolute targets are excluded; query strings do not affect
 * resolution against the source file. The checker never rewrites, and
 * symlinked instruction files are deduped.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import type { Nodes } from 'mdast'
import { parseMarkdown, visitMarkdown } from './markdown.ts'
import { isArchivedAgentNotePath, uniqueRepoFiles } from './repo-files.ts'

const root = resolve(import.meta.dirname, '..')

/** Repo-authored Markdown checked for relative links. */
const PATTERNS = [
  'README.md',
  'README.zh.md',
  '.agents/notes/**/*.md',
  'docs/**/*.md',
  'packages/*/*.md',
  'packages/*/*/*.md',
  'examples/**/*.md',
  'AGENTS.md',
  'packages/AGENTS.md',
  '.agents/skills/**/*.md',
  'skills/**/*.md',
]

/** A broken relative link: a missing target path or a missing anchor on it. */
interface Violation {
  file: string
  /** 1-based line where the link/image/definition node starts. */
  line: number
  url: string
  /** What failed: the target file or the fragment onto it. */
  reason: 'target' | 'anchor'
}

/**
 * True for targets this gate must NOT check: scheme-qualified URLs (`https:`,
 * `mailto:`, …), protocol-relative (`//host`), and root-absolute (`/path`).
 * Pure in-page anchors (`#frag`) ARE checked, against the source file itself.
 */
function isExternal(url: string): boolean {
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

/** The percent-decoded `#fragment` of a link target, or null when it has none. */
function fragmentPart(url: string): string | null {
  const hash = url.indexOf('#')
  if (hash === -1) return null
  const raw = url.slice(hash + 1).replace(/\?.*$/, '')
  try {
    return decodeURIComponent(raw)
  } catch {
    // Same stance as pathPart: a malformed escape names no anchor anyone
    // meant, so the raw text flows into the lookup and is reported missing.
    return raw
  }
}

/**
 * GitHub's heading-slug algorithm (lowercase; drop everything but letters,
 * numbers, spaces, hyphens; spaces become hyphens) — the same rule
 * `gen-cordis-catalog`'s region anchors are built from, kept in sync by the
 * corpus passing this gate rather than by a shared import across the
 * script/package boundary.
 * @param heading - the rendered heading text.
 * @returns the anchor GitHub assigns the first occurrence of the heading.
 */
export function githubSlug(heading: string): string {
  return heading.toLowerCase().replace(/[^\p{L}\p{N} -]/gu, '').replaceAll(' ', '-')
}

/**
 * Every anchor one Markdown document exposes: each heading's GitHub slug
 * (repeated headings get the renderer's `-1`, `-2`, … suffixes) plus every
 * explicit `<a id="…">`. Lowercased for case-insensitive fragment matching.
 * @param source - the document's full Markdown text.
 * @returns the set of valid fragments for links into this document.
 */
export function documentAnchors(source: string): Set<string> {
  const anchors = new Set<string>()
  const seen = new Map<string, number>()
  const tree = parseMarkdown(source)
  visitMarkdown(tree, (node: Nodes): void => {
    if (node.type === 'heading') {
      const text = source.slice(node.position?.start.offset ?? 0, node.position?.end.offset ?? 0)
        .replace(/^#{1,6}\s+/, '')
        .replace(/[`*_]/g, '')
      const base = githubSlug(text)
      const bump = seen.get(base) ?? 0
      seen.set(base, bump + 1)
      anchors.add(bump === 0 ? base : `${base}-${bump}`)
    }
  })
  for (const match of source.matchAll(/<a id="([^"]+)"/g)) anchors.add((match[1] ?? '').toLowerCase())
  return anchors
}

/** Lazily collect and cache the anchor set of any existing Markdown file. */
function anchorCache(): (absPath: string) => Set<string> {
  const cache = new Map<string, Set<string>>()
  return (absPath) => {
    const hit = cache.get(absPath)
    if (hit) return hit
    const anchors = documentAnchors(readFileSync(absPath, 'utf8'))
    cache.set(absPath, anchors)
    return anchors
  }
}

/**
 * Find every broken relative cross-link in one Markdown file via its AST: a
 * relative target that does not exist, or a fragment onto a Markdown file
 * (same-file `#anchor` links included) that names no heading slug or explicit
 * `<a id>` there. Fragments onto non-Markdown targets (`file.ts#L10`) carry
 * renderer-owned semantics and are not judged.
 * @param absPath - absolute path of the Markdown source to scan.
 * @param anchorsOf - anchor lookup shared across files for cross-link checks.
 * @param scanRoot - repository root violations are reported relative to.
 * @returns one entry per broken link, in document order.
 */
export function findViolations(
  absPath: string,
  anchorsOf: (abs: string) => Set<string>,
  scanRoot: string = root,
): Violation[] {
  const file = relative(scanRoot, absPath)
  const dir = dirname(absPath)
  const source = readFileSync(absPath, 'utf8')
  const tree = parseMarkdown(source)
  const out: Violation[] = []

  const check = (url: string, node: Nodes): void => {
    if (isExternal(url)) return
    const target = pathPart(url)
    const resolved = target === '' ? absPath : resolve(dir, target)
    if (!existsSync(resolved)) {
      out.push({ file, line: node.position?.start.line ?? 0, url, reason: 'target' })
      return
    }
    const fragment = fragmentPart(url)
    if (fragment === null || !resolved.endsWith('.md')) return
    if (!anchorsOf(resolved).has(fragment.toLowerCase())) {
      out.push({ file, line: node.position?.start.line ?? 0, url, reason: 'anchor' })
    }
  }

  visitMarkdown(tree, (node: Nodes): void => {
    if ((node.type === 'link' || node.type === 'image' || node.type === 'definition') && 'url' in node) {
      check(node.url, node)
    }
  })
  return out
}

// Run only when invoked as a script, not when imported by the spec.
if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) {
  // Archived notes remain valid link targets, but their historical outbound links are frozen.
  const files = uniqueRepoFiles(root, PATTERNS, isArchivedAgentNotePath)
  const anchorsOf = anchorCache()
  const all = files.flatMap(file => findViolations(file.abs, anchorsOf))
  const checked = files.length

  if (all.length === 0) {
    console.log(`verify-md-links: ${checked} file(s) checked, all relative cross-links and fragments resolve.`)
    process.exit(0)
  }

  console.error('verify-md-links: broken relative cross-links found:')
  for (const v of all) {
    console.error(`  ${v.file}:${v.line}  ${v.url}  (${v.reason === 'target' ? 'target does not exist' : 'no such anchor in target'})`)
  }
  process.exit(1)
}
