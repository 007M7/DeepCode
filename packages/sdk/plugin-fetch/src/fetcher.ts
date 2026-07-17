/**
 * The `PluginFetcher` seam, its common `FetchedPlugin` result, and the
 * tag-dispatched entry point. A fetcher acquires one plugin source into a fresh
 * temp directory WITHOUT executing any pulled code, and reports immutable
 * provenance the wiring step pins the dependency to.
 *
 * @module @deepseek-ai/dsh-plugin-fetch/fetcher
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertNever } from './never.ts'
import type { CommitSha, Integrity } from './ids.ts'
import type { GithubSource, NpmSource, PluginSource } from './source.ts'

/** Immutable pin for a github fetch: the resolved commit the tarball came from. */
export interface GithubProvenance {
  readonly kind: 'github'
  readonly sha: CommitSha
}

/** Immutable pin for an npm fetch: exact version, tarball URL, and integrity. */
export interface NpmProvenance {
  readonly kind: 'npm'
  /** Concrete resolved version (e.g. `1.2.3`), never the requested range/tag. */
  readonly version: string
  /** Tarball URL the artifact resolved to. */
  readonly resolved: string
  /** Subresource integrity the artifact was verified against. */
  readonly integrity: Integrity
}

/** Provenance a fetch records so wiring can pin an immutable dependency. */
export type PluginProvenance = GithubProvenance | NpmProvenance

/** The common result of fetching any plugin source. */
export interface FetchedPlugin {
  /** Absolute temp directory holding the extracted, UN-executed source. */
  readonly dir: string
  /** The source that produced this fetch, echoed for the wiring step. */
  readonly source: PluginSource
  /** Immutable provenance to pin the dependency during wiring. */
  readonly provenance: PluginProvenance
}

/**
 * A fetcher for one source kind. Implementations resolve the immutable pin
 * BEFORE download and must never run lifecycle scripts or template actions.
 */
export interface PluginFetcher<S extends PluginSource = PluginSource> {
  /** The single source kind this fetcher handles. */
  readonly kind: S['kind']
  /**
   * Fetch one source into a fresh temp directory.
   * @param source - the resolved source to fetch.
   * @returns the temp dir plus immutable provenance.
   */
  fetch(source: S): Promise<FetchedPlugin>
}

/** The per-kind fetchers {@link fetchPlugin} dispatches across. */
export interface PluginFetchers {
  readonly github: PluginFetcher<GithubSource>
  readonly npm: PluginFetcher<NpmSource>
}

/**
 * Dispatch one source to its fetcher by discriminant tag.
 * @param source - the resolved plugin source.
 * @param fetchers - the per-kind fetchers to route across.
 * @returns the fetch result from the matching fetcher.
 */
export function fetchPlugin(source: PluginSource, fetchers: PluginFetchers): Promise<FetchedPlugin> {
  switch (source.kind) {
    case 'github': return fetchers.github.fetch(source)
    case 'npm': return fetchers.npm.fetch(source)
    default: return assertNever(source, 'fetchPlugin')
  }
}

/**
 * Create a fresh, empty temp directory for one fetch — the default temp-dir
 * seam shared by the concrete fetchers.
 * @param prefix - a `mkdtemp` name prefix identifying the fetch kind.
 * @returns the absolute path of the created directory.
 */
export function createTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}
