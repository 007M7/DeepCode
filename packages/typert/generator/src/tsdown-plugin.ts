/**
 * Optional tsdown (rolldown) plugin face of the typert generator. When added
 * to a workspace tsdown config, it runs after each opted-in package bundle is
 * written and re-emits its model-driven face artifact at the package output
 * root. Packages without a Typert or Remote export are skipped.
 * @module @deepseek-ai/dsh-typert-generator/tsdown
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { WorkspaceTypertGenerator } from './workspace.ts'
import type { WorkspaceEmitResult } from './workspace.ts'
import type { TypertFace } from './model.ts'

/** The subset of the rolldown output-plugin contract this plugin uses (structural; avoids a rolldown type dependency). */
interface TypertPlugin {
  name: string
  writeBundle: (options: { dir?: string }) => void
}

/** Generation scope selected by a tsdown build phase. */
export interface TypertPluginOptions {
  /** Package mode emits only the package being bundled; workspace mode emits every explicit contributor once. */
  readonly mode?: 'package' | 'workspace'
  /** Independent TypeScript program faces included in this phase. */
  readonly faces?: readonly TypertFace[]
}

/**
 * Create the typert generation plugin for the root tsdown config.
 * @param pluginOptions - package/workspace emission mode and independent program faces.
 * @returns a rolldown-compatible plugin that emits local face and Host-for-Client Remote artifacts.
 */
export function typertPlugin(pluginOptions: TypertPluginOptions = {}): TypertPlugin {
  const artifactsByRoot = new Map<string, readonly WorkspaceEmitResult[]>()
  const emittedWorkspaces = new Set<string>()
  return {
    name: 'dsh-typert-generator',
    writeBundle(bundleOptions) {
      // options.dir is the package's absolute outDir (<package>/lib); its
      // nearest package.json owns the bundle even when a custom config writes
      // a nested output such as <package>/lib/dev.
      if (bundleOptions.dir === undefined) return
      const root = workspaceRoot(bundleOptions.dir)
      if (emittedWorkspaces.has(root)) return
      if (pluginOptions.mode === 'workspace') {
        emitWorkspace(root, pluginOptions.faces)
        emittedWorkspaces.add(root)
        return
      }
      const packageDir = packageRoot(bundleOptions.dir, root)
      if (packageDir === undefined) return
      const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
        name?: string
        exports?: unknown
      }
      if (manifest.name === undefined || !hasTypertExport(manifest.exports)) return
      let artifacts = artifactsByRoot.get(root)
      if (artifacts === undefined) {
        const generator = new WorkspaceTypertGenerator(root)
        artifacts = pluginOptions.faces === undefined
          ? generator.generate()
          : generator.generate(undefined, pluginOptions.faces)
        artifactsByRoot.set(root, artifacts)
      }
      emitArtifacts(packageDir, artifacts.filter(candidate => candidate.package === manifest.name))
    },
  }

  function emitWorkspace(root: string, faces: readonly TypertFace[] | undefined): void {
    const generator = new WorkspaceTypertGenerator(root)
    const packages = generator.discover(faces)
      .filter(candidate => hasTypertExport(readManifest(join(root, candidate.root)).exports))
      .map(candidate => candidate.package)
    if (packages.length === 0) return
    for (const artifact of generator.generate(packages, faces)) {
      emitArtifacts(join(root, artifact.packageRoot), [artifact])
    }
  }
}

function emitArtifacts(packageDir: string, artifacts: readonly WorkspaceEmitResult[]): void {
  const output = join(packageDir, 'lib')
  mkdirSync(output, { recursive: true })
  for (const artifact of artifacts) {
    writeFileSync(join(output, `typert.${artifact.face}.js`), artifact.js)
    writeFileSync(join(output, `typert.${artifact.face}.d.ts`), artifact.dts)
    if (artifact.remote !== undefined) {
      writeFileSync(join(output, 'typert.remote-client.js'), artifact.remote.js)
      writeFileSync(join(output, 'typert.remote-client.d.ts'), artifact.remote.dts)
      writeFileSync(join(output, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
    }
  }
}

function readManifest(packageDir: string): { name?: string; exports?: unknown } {
  return JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8')) as {
    name?: string
    exports?: unknown
  }
}

function hasTypertExport(exportsField: unknown): boolean {
  if (exportsField === null || typeof exportsField !== 'object' || Array.isArray(exportsField)) return false
  return Object.hasOwn(exportsField, './typert')
    || Object.hasOwn(exportsField, './client/typert')
    || Object.hasOwn(exportsField, './remote')
}

function packageRoot(start: string, workspace: string): string | undefined {
  let current = resolve(start)
  while (current !== workspace) {
    if (existsSync(join(current, 'package.json'))) return current
    current = dirname(current)
  }
  return undefined
}

function workspaceRoot(start: string): string {
  let current = resolve(start)
  while (!existsSync(join(current, 'tsconfig.host.json'))) {
    const parent = dirname(current)
    if (parent === current) throw new Error(`typert-generator: cannot find workspace root above ${start}`)
    current = parent
  }
  return current
}
