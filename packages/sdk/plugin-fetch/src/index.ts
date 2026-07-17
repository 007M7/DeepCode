/**
 * Fetch an external Cordis plugin (github or npm) into a temp directory —
 * pinned to an immutable commit/integrity and never executed — for the
 * `dsh-sdk create <source>` command. Parses a source spec, dispatches to the
 * matching fetcher, and returns a common {@link FetchedPlugin} the wiring step
 * pins and mounts.
 *
 * @module @deepseek-ai/dsh-plugin-fetch
 */

export { resolvePluginSource } from './source.ts'
export type { GithubSource, NpmSource, PluginSource } from './source.ts'
export { commitSha, integrity } from './ids.ts'
export type { CommitSha, Integrity } from './ids.ts'
export { createTempDir, fetchPlugin } from './fetcher.ts'
export type {
  FetchedPlugin,
  GithubProvenance,
  NpmProvenance,
  PluginFetcher,
  PluginFetchers,
  PluginProvenance,
} from './fetcher.ts'
export {
  createGigetFetcher,
  defaultResolveRef,
  GigetFetcher,
  GITHUB_TEMP_PREFIX,
} from './giget-fetcher.ts'
export type {
  DownloadTemplate,
  GigetFetcherDeps,
  GithubFetchOptions,
  ResolveRef,
} from './giget-fetcher.ts'
export {
  createPacoteFetcher,
  NPM_TEMP_PREFIX,
  PacoteFetcher,
} from './pacote-fetcher.ts'
export type {
  NpmFetchOptions,
  PacoteApi,
  PacoteExtractResult,
  PacoteFetcherDeps,
  PacoteFetchOptions,
  PacoteResolution,
} from './pacote-fetcher.ts'
