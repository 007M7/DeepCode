/**
 * Structured pnpm workspace configuration for generated SDK projects.
 *
 * @module @deepseek-ai/dsh-helper/documents/pnpm-workspace-file
 */

import { parse, stringify } from 'yaml'
import { ProjectFile, withTrailingNewline } from './project-file.ts'

/** Generated pnpm-workspace.yaml model. */
export class PnpmWorkspaceFile extends ProjectFile {
  private readonly packages = new Set<string>()
  private autoInstallPeers = true

  private constructor(originalText?: string) {
    super('pnpm-workspace.yaml', originalText)
  }

  /** Create a pnpm workspace document. */
  static create(): PnpmWorkspaceFile {
    return new PnpmWorkspaceFile()
  }

  /** Parse the workspace fields the SDK owns. */
  static parse(text: string): PnpmWorkspaceFile {
    const value: unknown = parse(text)
    if (value === null || Array.isArray(value) || typeof value !== 'object') {
      throw new Error('pnpm-workspace.yaml root must be an object')
    }
    const input = value as Record<string, unknown>
    if (!Array.isArray(input.packages) || input.packages.some(item => typeof item !== 'string')) {
      throw new Error('pnpm-workspace.yaml packages must be an array of strings')
    }
    const document = new PnpmWorkspaceFile(text)
    for (const pattern of input.packages) document.packages.add(pattern as string)
    if (input.autoInstallPeers !== undefined && typeof input.autoInstallPeers !== 'boolean') {
      throw new Error('pnpm-workspace.yaml autoInstallPeers must be boolean')
    }
    document.autoInstallPeers = input.autoInstallPeers !== false
    return document
  }

  /** Clone workspace globs and peer-install policy. */
  override clone(): PnpmWorkspaceFile {
    const clone = new PnpmWorkspaceFile(this.originalText)
    for (const pattern of this.packages) clone.packages.add(pattern)
    clone.autoInstallPeers = this.autoInstallPeers
    return clone
  }

  /** Add one package workspace glob. */
  addPackage(pattern: string): void {
    this.packages.add(pattern)
  }

  /** Disable registry peer auto-installation for live-link projects. */
  disableAutoInstallPeers(): void {
    this.autoInstallPeers = false
  }

  /** Validate workspace globs. */
  override validate(): void {
    for (const pattern of this.packages) {
      if (pattern.trim().length === 0) throw new Error('pnpm workspace pattern must not be empty')
    }
  }

  /** Serialize pnpm's workspace and peer policy. */
  override serialize(): string {
    return withTrailingNewline(stringify({
      packages: [...this.packages].sort(),
      ...this.autoInstallPeers ? {} : { autoInstallPeers: false },
      allowBuilds: { esbuild: true },
    }, { lineWidth: 0 }))
  }
}
