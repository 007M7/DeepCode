/**
 * Workspace package invariant checks for package-manager-independent quality
 * gates.
 *
 * Run: `tsx scripts/check-workspace-constraints.ts`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
// vendor/* is single-level; packages/<group>/<pkg> nests one level deeper
// (the group dirs — core/llm/bash/… — are pure containers with no manifest).
const workspaceGlobs = [
  { dir: 'vendor', depth: 1 },
  { dir: 'packages', depth: 2 },
] as const
const vendoredPackages = new Set([
  'cordis',
  'cosmokit',
  'schemastery',
  '@cordisjs/plugin-loader',
  '@cordisjs/plugin-include',
  '@cordisjs/plugin-group',
  '@cordisjs/plugin-timer',
  '@cordisjs/plugin-hmr',
  '@cordisjs/plugin-logger-console',
])

/** The subset of package.json fields this constraint check cares about. */
interface PackageManifest {
  name?: string
  version?: string
  private?: boolean
  type?: string
  main?: string
  types?: string
  bin?: string | Record<string, string>
  exports?: Record<
    string,
    | {
      types?: string
      default?: string
    }
    | undefined
  >
  files?: string[]
  peerDependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

/** One workspace manifest and its repo-relative path. */
interface WorkspaceManifest {
  dir: string
  manifest: PackageManifest
}

function readJson(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as PackageManifest
}

/** Repo-relative dirs holding a package.json, walked to the configured depth. */
function packageDirs(base: string, depth: number): string[] {
  if (depth === 1) {
    return readdirSync(join(root, base), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(base, entry.name))
  }
  return readdirSync(join(root, base), { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .flatMap(group => packageDirs(join(base, group.name), depth - 1))
}

function workspaceManifests(): WorkspaceManifest[] {
  const manifests: WorkspaceManifest[] = [
    { dir: '.', manifest: readJson(join(root, 'package.json')) },
  ]

  for (const { dir: base, depth } of workspaceGlobs) {
    for (const dir of packageDirs(base, depth)) {
      manifests.push({ dir, manifest: readJson(join(root, dir, 'package.json')) })
    }
  }

  return manifests
}

const dshPackageFiles = [
  'lib/index.js',
  'lib/types/**/*.d.ts',
  'lib/types/**/*.d.ts.map',
  'src',
] as const

const dshBinPackageFiles = [
  'lib/index.js',
  'lib/bin.js',
  'lib/types/**/*.d.ts',
  'lib/types/**/*.d.ts.map',
  'src',
] as const

function sameStringList(actual: readonly string[] | undefined, expected: readonly string[]): boolean {
  return !!actual && actual.length === expected.length && actual.every((value, index) => value === expected[index])
}

function expectedDshPackageFiles(manifest: PackageManifest): readonly string[] {
  return manifest.bin ? dshBinPackageFiles : dshPackageFiles
}

function checkWorkspace({ dir, manifest }: WorkspaceManifest): string[] {
  const errors: string[] = []
  const label = manifest.name ?? dir

  if (manifest.private !== true) {
    errors.push(`${label}: package.json must set "private": true`)
  }

  if (manifest.name && vendoredPackages.has(manifest.name)) {
    return errors
  }

  if (manifest.name?.startsWith('@deepseek-ai/dsh-') && manifest.name !== '@deepseek-ai/dsh-root') {
    const peer = manifest.peerDependencies?.cordis
    const dev = manifest.devDependencies?.cordis

    if (!peer) errors.push(`${label}: cordis must be a peerDependency`)
    if (!dev) errors.push(`${label}: cordis must also be a devDependency`)
    if (peer && dev && peer !== dev) {
      errors.push(`${label}: cordis peer (${peer}) and dev (${dev}) ranges must match`)
    }
    if (manifest.version !== '0.0.1') {
      errors.push(`${label}: package.json must set "version": "0.0.1"`)
    }
    if (manifest.type !== 'module') {
      errors.push(`${label}: package.json must set "type": "module"`)
    }
    if (manifest.main !== 'lib/index.js') {
      errors.push(`${label}: package.json must set "main": "lib/index.js"`)
    }
    if (manifest.types !== 'lib/types/index.d.ts') {
      errors.push(`${label}: package.json must set "types": "lib/types/index.d.ts"`)
    }
    if (manifest.exports?.['.']?.types !== './lib/types/index.d.ts') {
      errors.push(`${label}: package.json exports["."].types must be "./lib/types/index.d.ts"`)
    }
    if (manifest.exports?.['.']?.default !== './lib/index.js') {
      errors.push(`${label}: package.json exports["."].default must be "./lib/index.js"`)
    }
    const expectedFiles = expectedDshPackageFiles(manifest)
    if (!sameStringList(manifest.files, expectedFiles)) {
      errors.push(`${label}: package.json files must be ${JSON.stringify(expectedFiles)}`)
    }
  }

  return errors.map(error => `${relative(root, join(root, dir, 'package.json'))}: ${error}`)
}

/**
 * Enforce the packages/ hierarchy SHAPE: every package lives at exactly
 * `packages/<group>/<pkg>`. A group dir is a pure container — it holds packages,
 * never sources of its own — so it must NOT carry a package.json, and a package
 * must NOT sit directly at the `packages/` root (the old flat layout) nor nest a
 * level deeper. The group NAMES are open on purpose: a new group may be added
 * without touching this gate, but the depth-2 shape is fixed. This is what keeps
 * a stray flat package or an over-nested one from regressing the hierarchy.
 */
function checkHierarchyShape(): string[] {
  const errors: string[] = []
  const packagesRoot = join(root, 'packages')
  for (const group of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue
    const groupRel = join('packages', group.name)
    if (existsSync(join(packagesRoot, group.name, 'package.json'))) {
      errors.push(`${groupRel}: a group dir must not contain a package.json — packages live at packages/<group>/<pkg>, not directly under packages/`)
      continue
    }
    for (const pkg of readdirSync(join(packagesRoot, group.name), { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const pkgRel = join(groupRel, pkg.name)
      if (!existsSync(join(packagesRoot, group.name, pkg.name, 'package.json'))) {
        errors.push(`${pkgRel}: expected a package here (no package.json found) — the hierarchy is exactly packages/<group>/<pkg>, no deeper nesting`)
      }
    }
  }
  return errors
}

const errors = [...workspaceManifests().flatMap(checkWorkspace), ...checkHierarchyShape()]
if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exitCode = 1
}
