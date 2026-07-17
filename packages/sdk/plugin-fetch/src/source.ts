/**
 * The `PluginSource` discriminated union and the resolver that parses one CLI
 * spec string into it. Ambiguous or malformed specs fail loud here — the single
 * earliest resolvable point — rather than surfacing as a confusing fetch error.
 *
 * Grammar:
 * - github: `owner/repo[/subdir]#ref` — a `#` unambiguously marks a github ref;
 *   `ref` is optional and, when omitted, the fetcher pins the default branch.
 * - npm: `pkg@version` (scoped `@scope/pkg@version`) — the `@version` is the
 *   only disambiguator from a bare `owner/repo` github locator.
 *
 * @module @deepseek-ai/dsh-plugin-fetch/source
 */

/** A plugin pulled from a github (git tarball) repository. */
export interface GithubSource {
  readonly kind: 'github'
  /** Repository owner (user or org). */
  readonly owner: string
  /** Repository name. */
  readonly repo: string
  /** Path within the repository to extract; absent means the repository root. */
  readonly subdir?: string
  /** Branch, tag, or commit; absent means the repository's default branch. */
  readonly ref?: string
}

/** A plugin pulled from an npm registry by exact package and version spec. */
export interface NpmSource {
  readonly kind: 'npm'
  /** Package name, including any `@scope/` prefix. */
  readonly name: string
  /** Registry version, range, or dist-tag (non-empty). */
  readonly version: string
}

/** Every plugin origin `dsh-sdk create <source>` understands. */
export type PluginSource = GithubSource | NpmSource

/** One `/`-separated github name segment (owner, repo, or subdir component). */
function isNameSegment(segment: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(segment) && segment !== '.' && segment !== '..'
}

/** A git ref: branch, tag, or commit; permits `/`-nested names, rejects traversal. */
function isGitRef(ref: string): boolean {
  return /^[A-Za-z0-9._/-]+$/.test(ref)
    && !ref.includes('..')
    && !ref.startsWith('/')
    && !ref.endsWith('/')
}

/** An npm package name, scoped (`@scope/name`) or unscoped. */
function isNpmPackageName(name: string): boolean {
  const segment = /^[a-z0-9][a-z0-9._-]*$/
  if (name.startsWith('@')) {
    const slash = name.indexOf('/')
    if (slash < 2 || slash === name.length - 1) return false
    return segment.test(name.slice(1, slash)) && segment.test(name.slice(slash + 1))
  }
  return segment.test(name)
}

/** Parse a `owner/repo[/subdir]` locator with an optional already-split ref. */
function tryParseGithubLocator(locator: string, ref: string | undefined): GithubSource | undefined {
  if (!/^[^\s@#]+$/.test(locator)) return undefined
  const [owner, repo, ...subdirSegments] = locator.split('/')
  if (owner === undefined || repo === undefined) return undefined
  if (!isNameSegment(owner) || !isNameSegment(repo)) return undefined
  if (subdirSegments.some(segment => !isNameSegment(segment))) return undefined
  if (ref !== undefined && !isGitRef(ref)) return undefined
  const subdir = subdirSegments.join('/')
  return {
    kind: 'github',
    owner,
    repo,
    ...subdir.length > 0 ? { subdir } : {},
    ...ref !== undefined ? { ref } : {},
  }
}

/** Parse `pkg@version` (scoped or unscoped); undefined when it is not npm-shaped. */
function tryParseNpmSource(spec: string): NpmSource | undefined {
  if (/[\s#]/.test(spec)) return undefined
  // A scoped spec's version `@` follows the scope's `/`; an unscoped spec's is
  // the first `@`. A leading `@` with no version `@` yields index 0 (rejected).
  const versionAt = spec.startsWith('@') ? spec.indexOf('@', spec.indexOf('/') + 1) : spec.indexOf('@')
  if (versionAt <= 0) return undefined
  const name = spec.slice(0, versionAt)
  const version = spec.slice(versionAt + 1)
  if (version.length === 0 || version.includes('/')) return undefined
  if (!isNpmPackageName(name)) return undefined
  return { kind: 'npm', name, version }
}

/**
 * Parse one `dsh-sdk create <source>` spec into a {@link PluginSource}.
 * @param spec - the raw source argument.
 * @returns the discriminated source.
 * @throws if the spec is empty, malformed, or ambiguous between github and npm.
 */
export function resolvePluginSource(spec: string): PluginSource {
  const trimmed = spec.trim()
  if (trimmed.length === 0) throw new Error('plugin source must not be empty')

  const hashIndex = trimmed.indexOf('#')
  if (hashIndex !== -1) {
    const ref = trimmed.slice(hashIndex + 1)
    if (ref.length === 0) {
      throw new Error(`github plugin source is missing a ref after '#': ${JSON.stringify(spec)}`)
    }
    const source = tryParseGithubLocator(trimmed.slice(0, hashIndex), ref)
    if (!source) {
      throw new Error(`invalid github plugin source: ${JSON.stringify(spec)} — expected "owner/repo[/subdir]#ref"`)
    }
    return source
  }

  const npm = tryParseNpmSource(trimmed)
  if (npm) return npm
  const github = tryParseGithubLocator(trimmed, undefined)
  if (github) return github
  throw new Error(
    `unrecognized plugin source: ${JSON.stringify(spec)} — expected "owner/repo[/subdir]#ref" (github) or "pkg@version" (npm)`,
  )
}
