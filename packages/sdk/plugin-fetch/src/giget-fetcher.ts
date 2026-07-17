/**
 * The github {@link PluginFetcher}, backed by `@bluwy/giget-core`.
 *
 * `@bluwy/giget-core` is chosen over unjs `giget`: it carries a single runtime
 * dependency (`modern-tar`) versus giget's CLI/registry stack, and it dropped
 * the `install` and JSON-registry options entirely, so a fetch can only ever
 * download and untar a tarball — never run install or degit-style actions. That
 * is exactly the "extract, never execute" guarantee this feature needs.
 *
 * The commit is pinned BEFORE download: {@link GigetFetcher} resolves `#ref` to
 * an immutable SHA (default via the GitHub commits API), then downloads that
 * SHA. Provenance carries the SHA so wiring pins `github:owner/repo#<sha>`.
 *
 * @module @deepseek-ai/dsh-plugin-fetch/giget-fetcher
 */

import { downloadTemplate } from '@bluwy/giget-core'
import { createTempDir, type FetchedPlugin, type PluginFetcher } from './fetcher.ts'
import { commitSha, type CommitSha } from './ids.ts'
import type { GithubSource } from './source.ts'

/** Temp-dir name prefix for github fetches. */
export const GITHUB_TEMP_PREFIX = 'dsh-plugin-github-'

/** Downloads a giget input string into `dir`; the tarball-extraction seam. */
export type DownloadTemplate = (
  input: string,
  options: { dir: string; force: 'clean' },
) => Promise<{ dir: string }>

/** Resolves a github source's ref to an immutable commit SHA before download. */
export type ResolveRef = (source: GithubSource) => Promise<CommitSha>

/** The injected collaborators a {@link GigetFetcher} needs. */
export interface GigetFetcherDeps {
  /** Downloads a pinned giget input into a directory. */
  download: DownloadTemplate
  /** Resolves `source.ref` (or the default branch) to a commit SHA. */
  resolveRef: ResolveRef
  /** Allocates the fresh temp directory to download into. */
  createTempDir: (prefix: string) => Promise<string>
}

/** Build the giget input string that pins a github source to a commit SHA. */
function gigetInput(source: GithubSource, sha: CommitSha): string {
  const path = source.subdir ? `${source.owner}/${source.repo}/${source.subdir}` : `${source.owner}/${source.repo}`
  return `${path}#${sha}`
}

/** A human-readable label for one github source, for error messages. */
function githubLabel(source: GithubSource): string {
  return `${source.owner}/${source.repo}#${source.ref ?? 'HEAD'}`
}

/**
 * Resolve a github source's ref to an immutable SHA via the GitHub commits API.
 * Uses the `application/vnd.github.sha` media type, which returns the resolved
 * commit id as plain text.
 * @param source - the github source; an absent `ref` resolves the default branch (`HEAD`).
 * @param token - optional bearer token for private repositories.
 * @returns the resolved immutable commit SHA.
 * @throws if the GitHub API rejects the request.
 */
export async function defaultResolveRef(source: GithubSource, token?: string): Promise<CommitSha> {
  const ref = source.ref ?? 'HEAD'
  const url = `https://api.github.com/repos/${source.owner}/${source.repo}/commits/${ref}`
  const headers: Record<string, string> = { Accept: 'application/vnd.github.sha' }
  if (token !== undefined) headers.Authorization = `Bearer ${token}`
  const response = await fetch(url, { headers })
  if (!response.ok) {
    throw new Error(`cannot resolve github ref ${githubLabel(source)}: HTTP ${response.status}`)
  }
  return commitSha((await response.text()).trim())
}

/** Fetches a github plugin source by pinning `#ref` to a commit SHA, then downloading it. */
export class GigetFetcher implements PluginFetcher<GithubSource> {
  readonly kind = 'github' as const
  private readonly deps: GigetFetcherDeps

  /** Construct with injected download, ref-resolution, and temp-dir seams. */
  constructor(deps: GigetFetcherDeps) {
    this.deps = deps
  }

  async fetch(source: GithubSource): Promise<FetchedPlugin> {
    const sha = await this.deps.resolveRef(source)
    const dir = await this.deps.createTempDir(GITHUB_TEMP_PREFIX)
    await this.deps.download(gigetInput(source, sha), { dir, force: 'clean' })
    return { dir, source, provenance: { kind: 'github', sha } }
  }
}

/** Options for the production github fetcher. */
export interface GithubFetchOptions {
  /** Bearer token for private repositories; defaults to `GITHUB_TOKEN`. */
  token?: string
}

/**
 * Build the production github fetcher wired to `@bluwy/giget-core` and the
 * GitHub commits API.
 * @param options - optional token override (else `process.env.GITHUB_TOKEN`).
 * @returns a {@link GigetFetcher} using the real download and ref-resolution seams.
 */
export function createGigetFetcher(options: GithubFetchOptions = {}): GigetFetcher {
  const token = options.token ?? process.env.GITHUB_TOKEN
  return new GigetFetcher({
    download: (input, downloadOptions) => downloadTemplate(input, {
      ...downloadOptions,
      ...token !== undefined ? { providerOptions: { auth: token } } : {},
    }),
    resolveRef: source => defaultResolveRef(source, token),
    createTempDir,
  })
}
