/**
 * Workspace package invariant checks for package-manager-independent quality
 * gates.
 *
 * Run: `tsx scripts/check-workspace-constraints.ts`.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const workspaceGlobs = ['vendor', 'packages'] as const
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

function workspaceManifests(): WorkspaceManifest[] {
  const manifests: WorkspaceManifest[] = [
    { dir: '.', manifest: readJson(join(root, 'package.json')) },
  ]

  for (const workspaceDir of workspaceGlobs) {
    for (const entry of readdirSync(join(root, workspaceDir), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(workspaceDir, entry.name)
      manifests.push({ dir, manifest: readJson(join(root, dir, 'package.json')) })
    }
  }

  return manifests
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
  }

  return errors.map(error => `${relative(root, join(root, dir, 'package.json'))}: ${error}`)
}

const errors = workspaceManifests().flatMap(checkWorkspace)
if (errors.length > 0) {
  console.error(errors.join('\n'))
  process.exitCode = 1
}
