/**
 * Doc-sync gate: every package README carries the standard
 * `## Known Limitations and Deferred Work` section — the per-package home for
 * consumer-visible gaps and consciously postponed work that the
 * [documentation standard](../docs/AGENTS.md) assigns to the package-README
 * tier. One canonical heading instead of per-package variants ("Limitations",
 * "What is NOT here", …) keeps the section greppable across the repo and makes
 * its absence a gate failure rather than an oversight.
 *
 * A package with genuinely nothing to declare is listed in NO_LIMITATIONS
 * below and must NOT carry the section — an empty section invites boilerplate,
 * and a whitelisted package that gains real limitations leaves the whitelist
 * in the same change. Whitelist entries are validated against the scanned
 * package set, so a rename or removal fails loud instead of silently
 * un-gating a README.
 *
 * The package set comes from `packages/<group>/<package>/package.json`, so a manifest with no
 * sibling README fails instead of escaping a README-only glob. Checks, per
 * package README (fenced code and HTML comments excluded):
 * 1. Non-whitelisted: exactly one limitations-like heading, byte-equal to the
 *    canonical h2, with at least one top-level `- ` bullet before the next
 *    heading.
 * 2. Whitelisted: no limitations-like heading at all.
 * 3. Every whitelist entry names a scanned package.
 *
 * "Limitations-like" also matches near-miss headings at any level ("known
 * limitations", "deferred work", "what is not here", a heading starting with
 * "limitations"/"deferred") so a drifted heading cannot impersonate the
 * canonical section and a second competing section cannot coexist with it.
 *
 * Checker, not fixer: it reports and never rewrites.
 * Run: `tsx scripts/verify-package-readme-limitations.ts`.
 */

import { existsSync, globSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { markdownHeadingLines, markdownProseLines } from './markdown.ts'

const root = resolve(import.meta.dirname, '..')

/** The one canonical section heading, required verbatim as an h2. */
const CANONICAL = '## Known Limitations and Deferred Work'

/**
 * Packages with genuinely no known limitations or deferred work (keyed by
 * package directory relative to the repo root). Their READMEs must NOT carry
 * the section; adding one moves the package off this list in the same change.
 */
const NO_LIMITATIONS: Readonly<Record<string, string>> = {
  'packages/util/brand': 'Type-only nominal-branding primitive with no runtime behavior or deferred work.',
}

/** A heading that reads as a limitations section — canonical or drifted. */
function isLimitationsLike(headingText: string): boolean {
  return (
    /\blimitations?\b/i.test(headingText)
    || /deferred work/i.test(headingText)
    || /what is not here/i.test(headingText)
    || /^deferred\b/i.test(headingText)
    || /^non-goals?\b/i.test(headingText)
  )
}

const packageJsons = globSync('packages/*/*/package.json', { cwd: root }).sort()
const scannedPackages = new Set(packageJsons.map(path => path.slice(0, -'/package.json'.length)))
const failures: string[] = []

for (const [entry, reason] of Object.entries(NO_LIMITATIONS)) {
  if (!scannedPackages.has(entry)) {
    failures.push(`whitelist entry ${entry} does not name a scanned package — renamed or removed? update NO_LIMITATIONS in scripts/verify-package-readme-limitations.ts in the same change`)
  }
  if (reason.trim().length === 0) {
    failures.push(`whitelist entry ${entry} has no justification — state why a limitations section would be empty boilerplate`)
  }
}

for (const pkg of scannedPackages) {
  const readme = `${pkg}/README.md`
  if (!existsSync(resolve(root, readme))) {
    failures.push(`${readme}: package manifest has no sibling README with the \`${CANONICAL}\` section`)
    continue
  }
  const source = readFileSync(resolve(root, readme), 'utf8')
  const lines = markdownProseLines(source)
  const headings = markdownHeadingLines(source)
  const limitations = headings.filter(heading => isLimitationsLike(heading.text))

  if (Object.hasOwn(NO_LIMITATIONS, pkg)) {
    for (const heading of limitations) {
      failures.push(`${readme}:${heading.index}: whitelisted as having no known limitations, but carries ${JSON.stringify(heading.raw)} — drop the section or remove the package from NO_LIMITATIONS`)
    }
    continue
  }

  const heading = limitations.at(0)
  if (heading === undefined) {
    failures.push(`${readme}: missing the \`${CANONICAL}\` section (a package with genuinely nothing to declare joins NO_LIMITATIONS in scripts/verify-package-readme-limitations.ts instead)`)
    continue
  }
  if (limitations.length > 1) {
    failures.push(`${readme}: ${limitations.length} limitations-like headings (lines ${limitations.map(line => line.index).join(', ')}) — keep exactly one \`${CANONICAL}\` section`)
    continue
  }
  if (heading.depth !== 2 || heading.raw.trimEnd() !== CANONICAL) {
    failures.push(`${readme}:${heading.index}: non-canonical heading ${JSON.stringify(heading.raw)} — use \`${CANONICAL}\``)
    continue
  }
  const headingAt = lines.findIndex(line => line.index === heading.index)
  const body = lines.slice(headingAt + 1)
  const headingLines = new Set(headings.map(entry => entry.index))
  const end = body.findIndex(line => headingLines.has(line.index))
  const section = end === -1 ? body : body.slice(0, end)
  if (!section.some(line => /^- /.test(line.raw))) {
    failures.push(`${readme}:${heading.index}: the \`${CANONICAL}\` section has no top-level \`- \` bullet — state the limitations, or whitelist the package if there are genuinely none`)
  }
}

if (failures.length > 0) {
  console.error('verify-package-readme-limitations: violations found:')
  for (const failure of failures) console.error(`  ${failure}`)
  process.exit(1)
}

console.log(`verify-package-readme-limitations: ${scannedPackages.size} package READMEs checked (${Object.keys(NO_LIMITATIONS).length} whitelisted), all conform.`)
