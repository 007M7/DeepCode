/**
 * Bump one release family's version and commit it, so the published version is
 * readable from the repository rather than derived inside CI
 * ([rationale](../../.agents/notes/proposed/process/2026-08-10-npm-release-sequences.md)).
 *
 * The dsh family shares one version: `major`, `minor`, `patch`, or an explicit
 * `x.y.z` (including a prerelease such as `0.0.1-rc.1`). The vendored family
 * has one version line per package and publishes only what changed since that
 * package's own `vendor-<package>-v*` tag, which is the record of the commit it
 * last published from.
 *
 * The version lands in the manifests, the lockfile follows, and a human creates
 * the tag after the commit merges. CI never writes to the repository.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join, matchesGlob } from 'node:path'
import { parseArgs } from 'node:util'
import { releaseFamily, type ReleaseFamily, type ReleaseMember } from './families.ts'
import { capture } from './process.ts'

/** Files npm publishes whether or not `files` lists them. */
const ALWAYS_PUBLISHED = ['package.json', 'README*', 'LICENSE*', 'LICENCE*'] as const

/** Release types the dsh family accepts besides an explicit version. */
const RELEASE_TYPES = ['major', 'minor', 'patch'] as const

/**
 * Split a version into its release numbers, discarding any prerelease segment.
 * @param version - the current version.
 * @returns Major, minor, and patch.
 */
function releaseNumbers(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/.exec(version)
  if (match === null) throw new Error(`cannot read release numbers from version ${version}`)
  return [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * The next dsh version.
 * @param current - the family's current shared version.
 * @param request - `major`, `minor`, `patch`, or an explicit version.
 * @returns The target version.
 */
function nextSharedVersion(current: string, request: string): string {
  if (!RELEASE_TYPES.includes(request as typeof RELEASE_TYPES[number])) {
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(request)) {
      throw new Error(`usage: release:dsh <major|minor|patch|x.y.z>, got ${request}`)
    }
    return request
  }
  const [major, minor, patch] = releaseNumbers(current)
  if (request === 'major') return `${String(major + 1)}.0.0`
  if (request === 'minor') return `${String(major)}.${String(minor + 1)}.0`
  return `${String(major)}.${String(minor)}.${String(patch + 1)}`
}

/**
 * The version a vendored package publishes next: its release numbers with the
 * patch incremented, which also drops an upstream prerelease segment.
 * @param current - the package's current version.
 * @returns The target version.
 */
function nextVendorVersion(current: string): string {
  const [major, minor, patch] = releaseNumbers(current)
  return `${String(major)}.${String(minor)}.${String(patch + 1)}`
}

/**
 * Whether a repository-relative path reaches the member's published payload.
 * @param member - the member the path belongs to.
 * @param path - repository-relative path.
 * @returns True when `files` (or npm's always-published set) selects it.
 */
function reachesPayload(member: ReleaseMember, path: string): boolean {
  const relative = path.slice(member.directory.length + 1)
  const files = member.manifest.files
  const patterns = [
    ...ALWAYS_PUBLISHED,
    ...Array.isArray(files) ? files.filter((entry): entry is string => typeof entry === 'string') : [],
  ]
  return patterns.some(pattern =>
    matchesGlob(relative, pattern) || matchesGlob(relative, `${pattern}/**`) || relative === pattern)
}

/**
 * The newest tag a member published from, or undefined when it never published.
 * @param family - the member's family.
 * @param member - the member.
 * @returns The tag name.
 */
function lastPublishedTag(family: ReleaseFamily, member: ReleaseMember): string | undefined {
  const prefix = family.tagFor(member).replace(/-v[^-]*$/, '-v')
  const tags = capture('git', ['tag', '--list', `${prefix}*`, '--sort=-v:refname']).split('\n').filter(line => line !== '')
  return tags[0]
}

/**
 * Whether a member's published payload changed since it last published.
 * @param family - the member's family.
 * @param member - the member.
 * @returns True when the member needs a new version.
 */
function changedSincePublication(family: ReleaseFamily, member: ReleaseMember): boolean {
  const tag = lastPublishedTag(family, member)
  if (tag === undefined) return true
  const changed = capture('git', ['diff', '--name-only', `${tag}..HEAD`, '--', member.directory])
    .split('\n').filter(line => line !== '')
  return changed.some(path => reachesPayload(member, path))
}

/**
 * Write a version into a member's manifest, preserving formatting and key order.
 * @param root - repository root.
 * @param member - the member to rewrite.
 * @param version - the target version.
 */
function writeVersion(root: string, member: ReleaseMember, version: string): void {
  const path = join(root, member.directory, 'package.json')
  const text = readFileSync(path, 'utf8')
  const line = `"version": "${member.version}"`
  if (!text.includes(line)) throw new Error(`${member.directory}: cannot locate ${line}`)
  writeFileSync(path, text.replace(line, `"version": "${version}"`))
}

/** Bump the family named by `--family` and commit; `--dry-run` only reports the plan. */
function main(): void {
  const { values, positionals } = parseArgs({
    options: { family: { type: 'string' }, 'dry-run': { type: 'boolean', default: false } },
    allowPositionals: true,
  })
  if (values.family === undefined) throw new Error('usage: bump.ts --family <dsh|vendor> [version]')

  const family = releaseFamily(values.family)
  const root = process.cwd()
  const members = family.members(root)
  family.verifyVersions(members)

  const planned: { member: ReleaseMember; version: string }[] = []
  let sharedVersion: string | undefined
  if (family.id === 'dsh') {
    const request = positionals[0]
    if (request === undefined) throw new Error('usage: release:dsh <major|minor|patch|x.y.z>')
    const [first] = members
    if (first === undefined) throw new Error(`release family ${family.id} has no members`)
    sharedVersion = nextSharedVersion(first.version, request)
    for (const member of members) planned.push({ member, version: sharedVersion })
  } else {
    if (positionals.length > 0) throw new Error('release:vendor takes no version: each package increments its own patch')
    for (const member of members) {
      if (!changedSincePublication(family, member)) continue
      planned.push({ member, version: nextVendorVersion(member.version) })
    }
  }

  if (planned.length === 0) {
    console.log(`release bump: family ${family.id}, nothing changed since publication`)
    return
  }

  const dryRun = values['dry-run']
  if (!dryRun) {
    for (const { member, version } of planned) writeVersion(root, member, version)
    capture('pnpm', ['install', '--lockfile-only'])
  }

  const summary = sharedVersion
    ?? planned.map(entry => `${entry.member.name.replace('@deepseek-ai/', '')} ${entry.version}`).join(', ')
  console.log(`release bump: family ${family.id} -> ${summary}`)
  for (const { member, version } of planned) console.log(`  ${member.directory}: ${member.version} -> ${version}`)

  if (dryRun) {
    console.log('release bump: dry run, nothing written')
    return
  }
  capture('git', ['add', 'pnpm-lock.yaml', ...planned.map(entry => join(entry.member.directory, 'package.json'))])
  capture('git', ['commit', '-m', `release(${family.id}): ${summary}`])
  // The dsh family tags once for its shared version; vendor tags each package.
  const tags = [...new Set(planned.map(entry => family.tagFor({ ...entry.member, version: entry.version })))]
  console.log('release bump: committed. After this merges to master, tag it:')
  for (const tag of tags) console.log(`  git tag ${tag} <merge commit> && git push origin ${tag}`)
}

main()
