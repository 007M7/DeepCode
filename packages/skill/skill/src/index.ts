/**
 * Agent skill provider registry.
 *
 * This package is the interface third of the skill capability seam. Concrete
 * providers such as `@deepseek-ai/dsh-skill-local` decide where skills come
 * from; this service only merges provider catalogs, resolves the winning skill
 * for a name, and exposes the winning summaries and definitions to consumers.
 *
 * @module @deepseek-ai/dsh-skill
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import type Schema from 'schemastery'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DEFAULT_COLLECT_CACHE_ENTRIES = 128
const RUNTIME_PROVIDER = 'runtime'
const RUNTIME_RANK = 250

/**
 * Return whether a string is a valid kebab-case skill name.
 * @param name - candidate skill name to validate.
 * @returns whether the name matches the public skill-name grammar.
 */
export function isSkillName(name: string): boolean {
  return SKILL_NAME.test(name)
}

/** Origin bucket for a skill contribution. The value is prompt-visible metadata, not precedence by itself. */
export type SkillSource = 'project-dsh' | 'project-agents' | 'runtime' | 'user-dsh' | 'user-agents' | 'custom' | (string & {})

/** Optional provider-specific base used by loaded skill bodies to resolve relative resources. */
export type SkillResourceBase =
  | { kind: 'directory'; path: string }
  | { kind: 'url'; url: string }
  | { kind: 'opaque'; description: string }

/** Model-visible skill metadata returned by `ctx.skills.list()` and rendered into request guidance. */
export interface SkillSummary {
  /** Kebab-case identifier used with the `skill` tool. */
  name: string
  /** Short routing description shown to the model. */
  description: string
  /** Optional extra routing guidance shown to the model. */
  whenToUse?: string
  /** Whether the skill is hidden from model listings while remaining loadable by trusted callers. */
  disableModelInvocation?: boolean
  /** Discovery source that produced this winning skill. */
  source: SkillSource
  /** Provider that owns this skill body. */
  provider: string
  /** Provider-specific base for relative resources. */
  resourceBase?: SkillResourceBase
}

/** Provider catalog entry used by the registry to merge and later load skills. */
export interface SkillCandidate extends SkillSummary {
  /** Lower ranks win duplicate skill names before provider registration order is considered. */
  rank: number
  /** Opaque provider-owned handle passed back to `provider.get()`. */
  locator: unknown
  /** Absolute file path when the provider has one. */
  path?: string
  /** Parsed optional metadata object from provider-specific skill frontmatter. */
  metadata?: Record<string, unknown>
}

/** Complete parsed skill definition, including the body loaded by `ctx.skills.get()`. */
export interface SkillDefinition extends SkillSummary {
  /** Markdown instruction body after any provider-specific metadata removal. */
  content: string
  /** Absolute file path when the skill came from disk. */
  path?: string
  /** Parsed optional metadata object from frontmatter. */
  metadata?: Record<string, unknown>
}

/** Runtime skill contribution accepted by `ctx.skills.register()`. */
export type SkillRegistration = Omit<SkillDefinition, 'provider'> & { provider?: string }

/** Caller context used for cwd-sensitive and abortable provider work. */
export interface SkillLookupOptions {
  cwd?: string | undefined
  /** Abort discovery or loading work for the current caller. */
  signal?: AbortSignal | undefined
}

/** Provider interface for one source of skills, such as local directories or a remote registry. */
export interface SkillProvider {
  /** Unique provider name in the `ctx.skills` registry. */
  name: string
  /**
   * List available skill candidates for the current lookup context. Provider
   * plugins register synchronously during `apply()`; remote initialization,
   * authentication, and discovery are awaited inside this method. Implementations
   * should settle promptly when `options.signal` aborts.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns provider candidates with precedence ranks and opaque locators.
   */
  list(options: SkillLookupOptions): Promise<SkillCandidate[]>
  /**
   * Load a complete skill body for a previously listed candidate.
   * @param candidate - the winning candidate originally returned by this provider.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns the full skill body, or `undefined` if it is no longer loadable.
   */
  get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined>
}

/** Skill registry configuration. */
export interface Config {
  /** Maximum number of completed cwd/provider catalog snapshots kept in memory. */
  collectCacheMaxEntries?: number
}

declare module 'cordis' {
  interface Context {
    skills: SkillService
  }

  interface Events {
    /**
     * A skill provider became resolvable in the `ctx.skills` registry.
     * Consumers can observe this instead of depending on Cordis plugin load
     * order, which is concurrent for sibling plugins.
     * @param provider - the provider that just registered.
     * @mode emit
     */
    'skill/provider-added'(provider: SkillProvider): void
    /**
     * A skill provider left the registry because its plugin fiber was disposed.
     * @param name - the registry name that no longer resolves.
     * @mode emit
     */
    'skill/provider-removed'(name: string): void
  }
}

interface IndexedCandidate {
  candidate: SkillCandidate
  provider: SkillProvider
  providerOrder: number
  localOrder: number
}

interface CollectResult {
  entries: IndexedCandidate[]
  cacheable: boolean
}

/**
 * Registry of skill providers. It merges provider catalogs with stable
 * first-wins duplicate handling, exposes sorted model-visible summaries, and
 * loads full skill bodies on demand.
 */
export class SkillService extends Service {
  static Config: Schema<Config> = z.object({
    collectCacheMaxEntries: z.number().default(DEFAULT_COLLECT_CACHE_ENTRIES),
  })

  private readonly collectCacheMaxEntries: number
  private readonly providers = new Map<string, { provider: SkillProvider; order: number }>()
  private readonly runtime = new Map<string, SkillDefinition>()
  private readonly collectCache = new Map<string, IndexedCandidate[]>()
  private providerRevision = 0
  private nextProviderOrder = 0
  private runtimeRevision = 0

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'skills')
    this.collectCacheMaxEntries = config.collectCacheMaxEntries ?? DEFAULT_COLLECT_CACHE_ENTRIES
    assertPositiveInteger('collectCacheMaxEntries', this.collectCacheMaxEntries)
  }

  /**
   * Register a skill provider synchronously during the provider plugin's
   * `apply()`. Throws if another provider already owns the same provider name,
   * including the reserved runtime provider name. Providers that need remote
   * initialization do that work inside `list()` after registration. Effect-
   * scoped and HMR-safe: disposing the caller's fiber unregisters the provider
   * and invalidates cached catalogs.
   * @param provider - the provider to register by `provider.name`.
   * @returns a disposer that unregisters this provider.
   */
  registerProvider(provider: SkillProvider): () => void {
    const dispose = this.ctx.effect(function* (this: SkillService) {
      if (provider.name === RUNTIME_PROVIDER) {
        throw new Error(`"${RUNTIME_PROVIDER}" is reserved for runtime skill registrations`)
      }
      if (this.providers.has(provider.name)) {
        throw new Error(`a skill provider named "${provider.name}" is already registered`)
      }
      this.providers.set(provider.name, { provider, order: this.nextProviderOrder })
      this.nextProviderOrder += 1
      this.invalidateCache()
      yield () => {
        this.providers.delete(provider.name)
        this.invalidateCache()
        this.ctx.emit('skill/provider-removed', provider.name)
      }
      this.ctx.emit('skill/provider-added', provider)
    }.bind(this), 'skills.registerProvider()')
    return () => void dispose()
  }

  /**
   * Register a runtime skill contribution. Runtime registrations are treated as
   * embedded provider entries with project-over-user priority. Same-name runtime
   * registrations are first-wins: a duplicate logs a warning and gets a no-op
   * disposer so it cannot remove the active contribution.
   * @param skill - the complete skill definition to expose for discovery.
   * @returns a disposer that removes this runtime contribution and invalidates caches.
   */
  register(skill: SkillRegistration): () => void {
    const normalized = normalizeRuntimeSkill(skill)
    const existing = this.runtime.get(normalized.name)
    if (existing !== undefined) {
      this.ctx.logger.warn(`runtime skill "${normalized.name}" ignored because it is already registered`)
      return () => {}
    }
    const dispose = this.ctx.effect(function* (this: SkillService) {
      this.runtime.set(normalized.name, normalized)
      this.runtimeRevision += 1
      this.invalidateCache()
      yield () => {
        this.runtime.delete(normalized.name)
        this.runtimeRevision += 1
        this.invalidateCache()
      }
    }.bind(this), 'skills.register()')
    return () => void dispose()
  }

  /**
   * List model-invocable skill summaries for a workspace.
   * @param options - lookup options; `cwd` selects project roots and `signal` cancels discovery.
   * @returns sorted summaries, excluding skills disabled for model invocation.
   */
  async list(options: SkillLookupOptions = {}): Promise<SkillSummary[]> {
    return (await this.collect(options))
      .map(entry => entry.candidate)
      .filter(skill => skill.disableModelInvocation !== true)
      .map(toSummary)
      .sort(compareSkillSummary)
  }

  /**
   * Load one full skill definition by name.
   * @param name - kebab-case skill name.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns the full skill, including body content, or `undefined`.
   */
  async get(name: string, options: SkillLookupOptions = {}): Promise<SkillDefinition | undefined> {
    if (!isSkillName(name)) return undefined
    const match = (await this.collect(options)).find(entry => entry.candidate.name === name)
    if (match === undefined) return undefined
    return await match.provider.get(match.candidate, options)
  }

  private async collect(options: SkillLookupOptions): Promise<IndexedCandidate[]> {
    options.signal?.throwIfAborted()
    while (true) {
      const providerRevision = this.providerRevision
      const runtimeRevision = this.runtimeRevision
      const key = collectCacheKey(options, providerRevision, runtimeRevision)
      const cached = this.collectCache.get(key)
      if (cached !== undefined) return cached

      const result = await this.collectFresh(options)
      options.signal?.throwIfAborted()
      if (providerRevision !== this.providerRevision || runtimeRevision !== this.runtimeRevision) continue
      if (result.cacheable) {
        this.collectCache.set(key, result.entries)
        if (this.collectCache.size > this.collectCacheMaxEntries) {
          const oldest = this.collectCache.keys().next() as IteratorYieldResult<string>
          this.collectCache.delete(oldest.value)
        }
      }
      return result.entries
    }
  }

  private async collectFresh(options: SkillLookupOptions): Promise<CollectResult> {
    const collected = await this.listAllCandidates(options)
    collected.entries.sort(compareIndexedCandidates)
    const seen = new Set<string>()
    const result: IndexedCandidate[] = []
    for (const entry of collected.entries) {
      const skill = entry.candidate
      if (seen.has(skill.name)) {
        this.ctx.logger.warn(`skill "${skill.name}" from ${skill.source} ignored because a higher-priority skill already exists`)
        continue
      }
      seen.add(skill.name)
      result.push(entry)
    }
    return { entries: result, cacheable: collected.cacheable }
  }

  private async listAllCandidates(options: SkillLookupOptions): Promise<CollectResult> {
    options.signal?.throwIfAborted()
    const candidates: IndexedCandidate[] = []
    let cacheable = true
    let runtimeOrder = 0
    for (const skill of [...this.runtime.values()].sort((a, b) => compareCodePoints(a.name, b.name))) {
      candidates.push({
        candidate: runtimeCandidate(skill),
        provider: RUNTIME_SKILL_PROVIDER,
        providerOrder: -1,
        localOrder: runtimeOrder,
      })
      runtimeOrder += 1
    }
    for (const { provider, order } of [...this.providers.values()]) {
      let localOrder = 0
      let listed: SkillCandidate[] | undefined
      try {
        listed = await waitWithAbort(provider.list(options), options.signal)
      } catch (error) {
        if (options.signal?.aborted === true) throw toError(options.signal.reason)
        cacheable = false
        this.ctx.logger.warn(`skill provider "${provider.name}" skipped: ${errorMessage(error)}`)
      }
      if (listed === undefined) continue
      for (const candidate of listed) {
        validateCandidate(candidate, provider.name)
        candidates.push({ candidate, provider, providerOrder: order, localOrder })
        localOrder += 1
      }
    }
    return { entries: candidates, cacheable }
  }

  private invalidateCache(): void {
    this.providerRevision += 1
    this.collectCache.clear()
  }
}

const RUNTIME_SKILL_PROVIDER: SkillProvider = {
  name: RUNTIME_PROVIDER,
  /* v8 ignore next -- Runtime skills are injected directly by the registry; this provider only owns `get()`. */
  list() {
    return Promise.resolve([])
  },
  get(candidate) {
    const skill = candidate.locator as SkillDefinition
    return Promise.resolve({ ...skill })
  },
}

function runtimeCandidate(skill: SkillDefinition): SkillCandidate {
  return {
    ...toSummary(skill),
    rank: RUNTIME_RANK,
    locator: skill,
    ...skill.path !== undefined ? { path: skill.path } : {},
    ...skill.metadata !== undefined ? { metadata: skill.metadata } : {},
  }
}

function validateCandidate(candidate: SkillCandidate, providerName: string): void {
  if (!SKILL_NAME.test(candidate.name)) {
    throw new Error(`skill provider "${providerName}" returned invalid skill name "${candidate.name}"`)
  }
  if (candidate.description.length === 0) {
    throw new Error(`skill provider "${providerName}" returned skill "${candidate.name}" without a description`)
  }
  if (!Number.isFinite(candidate.rank)) {
    throw new Error(`skill provider "${providerName}" returned skill "${candidate.name}" with an invalid rank`)
  }
  if (candidate.provider !== providerName) {
    throw new Error(`skill provider "${providerName}" returned skill "${candidate.name}" for provider "${candidate.provider}"`)
  }
}

function normalizeRuntimeSkill(skill: SkillRegistration): SkillDefinition {
  if (!SKILL_NAME.test(skill.name)) throw new Error(`invalid skill name "${skill.name}"`)
  if (skill.description.length === 0) throw new Error(`skill "${skill.name}" requires a description`)
  return {
    ...skill,
    provider: skill.provider ?? RUNTIME_PROVIDER,
    source: skill.source,
  }
}

function toSummary(skill: SkillDefinition | SkillCandidate): SkillSummary {
  const { name, description, whenToUse, disableModelInvocation, source, provider, resourceBase } = skill
  return {
    name,
    description,
    ...whenToUse !== undefined ? { whenToUse } : {},
    ...disableModelInvocation !== undefined ? { disableModelInvocation } : {},
    source,
    provider,
    ...resourceBase !== undefined ? { resourceBase } : {},
  }
}

function compareSkillSummary(left: SkillSummary, right: SkillSummary): number {
  return compareCodePoints(left.name, right.name)
}

function compareCodePoints(left: string, right: string): number {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function compareIndexedCandidates(left: IndexedCandidate, right: IndexedCandidate): number {
  return left.candidate.rank - right.candidate.rank
    || left.providerOrder - right.providerOrder
    || left.localOrder - right.localOrder
}

function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`skill: ${name} must be an integer greater than or equal to ${minimum}`)
  }
}

function collectCacheKey(options: SkillLookupOptions, providerRevision: number, runtimeRevision: number): string {
  return JSON.stringify({ cwd: options.cwd, providerRevision, runtimeRevision })
}

function waitWithAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const cleanup = (): void => {
      signal.removeEventListener('abort', onAbort)
    }
    const onAbort = (): void => {
      cleanup()
      reject(toError(signal.reason))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(toError(error))
      },
    )
    if (signal.aborted) onAbort()
  })
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}

function errorMessage(error: unknown): string {
  return String(error)
}

export default SkillService
