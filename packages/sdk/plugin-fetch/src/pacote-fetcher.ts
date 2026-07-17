/**
 * The npm {@link PluginFetcher}, backed by `pacote`.
 *
 * Supply-chain safety comes from three layers: (1) {@link resolvePluginSource}
 * only ever produces a registry `name@version` spec, so pacote classifies it as
 * a registry source and cannot be steered to a git/file/dir spec whose
 * lifecycle scripts would run; (2) a registry tarball extract is a plain untar —
 * pacote runs no `prepare`/`postinstall` during {@link PacoteFetcher.fetch}; and
 * (3) the later wiring step installs with `--ignore-scripts`. The manifest is
 * resolved first so extract verifies the tarball against the registry-published
 * integrity (a mismatch raises `EINTEGRITY`).
 *
 * @module @deepseek-ai/dsh-plugin-fetch/pacote-fetcher
 */

import { extract as pacoteExtract, manifest as pacoteManifest } from 'pacote'
import { createTempDir, type FetchedPlugin, type PluginFetcher } from './fetcher.ts'
import { integrity } from './ids.ts'
import type { NpmSource } from './source.ts'

/** Temp-dir name prefix for npm fetches. */
export const NPM_TEMP_PREFIX = 'dsh-plugin-npm-'

/** The subset of pacote options this fetcher passes through. */
export interface PacoteFetchOptions {
  /** Registry to resolve against; absent uses pacote's default. */
  registry?: string
  /** Known resolved tarball URL, forwarded to extract. */
  resolved?: string
  /** Expected integrity, forwarded to extract for `EINTEGRITY` verification. */
  integrity?: string
}

/** The resolved registry manifest fields this fetcher pins from. */
export interface PacoteResolution {
  /** Resolved tarball URL. */
  _resolved: string
  /** Registry-published integrity. */
  _integrity: string
  /** Concrete resolved version. */
  version: string
}

/** The extract result fields this fetcher pins from. */
export interface PacoteExtractResult {
  /** Resolved tarball URL of the extracted artifact. */
  resolved: string
  /** Integrity of the extracted artifact. */
  integrity: string
}

/** The pacote surface a {@link PacoteFetcher} depends on; the fetch seam. */
export interface PacoteApi {
  /** Resolve a registry spec to its pinned manifest fields. */
  manifest: (spec: string, options?: PacoteFetchOptions) => Promise<PacoteResolution>
  /** Untar a registry spec into `dest`, verifying integrity when supplied. */
  extract: (spec: string, dest: string, options?: PacoteFetchOptions) => Promise<PacoteExtractResult>
}

/** The injected collaborators a {@link PacoteFetcher} needs. */
export interface PacoteFetcherDeps {
  /** The pacote resolve/extract surface. */
  pacote: PacoteApi
  /** Allocates the fresh temp directory to extract into. */
  createTempDir: (prefix: string) => Promise<string>
  /** Registry to resolve against; absent uses pacote's default. */
  registry?: string
}

/** Fetches an npm plugin source by resolving its manifest, then extracting the verified tarball. */
export class PacoteFetcher implements PluginFetcher<NpmSource> {
  readonly kind = 'npm' as const
  private readonly deps: PacoteFetcherDeps

  /** Construct with injected pacote, temp-dir, and optional registry seams. */
  constructor(deps: PacoteFetcherDeps) {
    this.deps = deps
  }

  async fetch(source: NpmSource): Promise<FetchedPlugin> {
    const spec = `${source.name}@${source.version}`
    const registryOptions: PacoteFetchOptions = this.deps.registry !== undefined
      ? { registry: this.deps.registry }
      : {}
    const resolution = await this.deps.pacote.manifest(spec, registryOptions)
    const dir = await this.deps.createTempDir(NPM_TEMP_PREFIX)
    const extracted = await this.deps.pacote.extract(spec, dir, {
      ...registryOptions,
      resolved: resolution._resolved,
      integrity: resolution._integrity,
    })
    return {
      dir,
      source,
      provenance: {
        kind: 'npm',
        version: resolution.version,
        resolved: extracted.resolved,
        integrity: integrity(extracted.integrity),
      },
    }
  }
}

/** Options for the production npm fetcher. */
export interface NpmFetchOptions {
  /** Registry to resolve against; absent uses pacote's default. */
  registry?: string
}

/**
 * Build the production npm fetcher wired to `pacote`.
 * @param options - optional registry override.
 * @returns a {@link PacoteFetcher} using the real pacote resolve/extract seam.
 */
export function createPacoteFetcher(options: NpmFetchOptions = {}): PacoteFetcher {
  const pacote: PacoteApi = {
    manifest: async (spec, pacoteOptions) => {
      const resolved = await pacoteManifest(spec, pacoteOptions)
      return { _resolved: resolved._resolved, _integrity: resolved._integrity, version: resolved.version }
    },
    extract: (spec, dest, pacoteOptions) => pacoteExtract(spec, dest, pacoteOptions),
  }
  return new PacoteFetcher({
    pacote,
    createTempDir,
    ...options.registry !== undefined ? { registry: options.registry } : {},
  })
}
