/**
 * Workspace-level discovery and model-driven Typert generation.
 * @module @deepseek-ai/dsh-typert-generator/workspace
 */

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { TypertAnalysisError, WorkspaceAnalyzer } from './analyzer.ts'
import type { DiscoveredTypertPackage } from './analyzer.ts'
import { FaceModelEmitter } from './emitter.ts'
import type { ModelEmitResult } from './emitter.ts'

/** One emitted artifact paired with its source package root. */
export interface WorkspaceEmitResult extends ModelEmitResult {
  readonly packageRoot: string
}

/** Discover, analyze, and emit package reflection from independent faces. */
export class WorkspaceTypertGenerator {
  /**
   * Bind generation to one workspace root.
   * @param root - directory containing face aggregate tsconfigs.
   */
  constructor(private readonly root: string) {}

  /**
   * Find public package faces that contribute Cordis services/events or
   * explicitly tagged Typert roots.
   * @returns discovered packages in stable package-name order.
   */
  discover(): DiscoveredTypertPackage[] {
    return new WorkspaceAnalyzer({ root: this.root }).discoverPackages()
  }

  /**
   * Generate all discovered contributors, or an explicit package subset.
   * @param packages - optional exact package names for a focused pass.
   * @returns one artifact per package face.
   */
  generate(packages?: readonly string[]): WorkspaceEmitResult[] {
    const selected = packages ?? this.discover().map(candidate => candidate.package)
    const workspace = new WorkspaceAnalyzer({ root: this.root, packages: selected }).analyze()
    const artifacts: WorkspaceEmitResult[] = []
    for (const face of workspace.faces) {
      const emitter = new FaceModelEmitter(face)
      for (const packageModel of face.packages) {
        const artifact = {
          ...emitter.emit(packageModel.name),
          packageRoot: packageModel.root,
        }
        this.validateExport(artifact)
        artifacts.push(artifact)
      }
    }
    return artifacts
  }

  private validateExport(artifact: WorkspaceEmitResult): void {
    const manifestPath = resolve(this.root, artifact.packageRoot, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      exports?: unknown
      files?: unknown
    }
    const subpath = artifact.face === 'host' ? './typert' : './client/typert'
    const expected = {
      types: `./lib/typert.${artifact.face}.d.ts`,
      default: `./lib/typert.${artifact.face}.js`,
    }
    const actual = manifest.exports !== null && typeof manifest.exports === 'object'
      ? (manifest.exports as Record<string, unknown>)[subpath]
      : undefined
    if (!sameExport(actual, expected)) {
      throw new TypertAnalysisError(
        `typert(${artifact.face}): ${artifact.package} must export ${subpath} as ${JSON.stringify(expected)}`,
      )
    }
    const files = Array.isArray(manifest.files) ? manifest.files : []
    for (const file of [`lib/typert.${artifact.face}.js`, `lib/typert.${artifact.face}.d.ts`]) {
      if (!files.includes(file)) {
        throw new TypertAnalysisError(`typert(${artifact.face}): ${artifact.package} package files must include ${file}`)
      }
    }
  }
}

function sameExport(actual: unknown, expected: { types: string; default: string }): boolean {
  if (actual === null || typeof actual !== 'object' || Array.isArray(actual)) return false
  const value = actual as Record<string, unknown>
  return value.types === expected.types && value.default === expected.default
}
