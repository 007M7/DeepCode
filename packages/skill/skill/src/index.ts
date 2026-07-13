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
  | { readonly kind: 'directory'; readonly path: string }
  | { readonly kind: 'url'; readonly url: string }
  | { readonly kind: 'opaque'; readonly description: string }

/** Model-visible skill metadata returned by `ctx.skills.list()` and rendered into request guidance. */
export interface SkillSummary {
  /** Kebab-case identifier used with the `skill` tool. */
  readonly name: string
  /** Short routing description shown to the model. */
  readonly description: string
  /** Optional extra routing guidance shown to the model. */
  readonly whenToUse?: string
  /** Whether the skill is hidden from model listings while remaining loadable by trusted callers. */
  readonly disableModelInvocation?: boolean
  /** Discovery source that produced this winning skill. */
  readonly source: SkillSource
  /** Provider that owns this skill body. */
  readonly provider: string
  /** Provider-specific base for relative resources. */
  readonly resourceBase?: SkillResourceBase
}

/** Provider catalog entry used by the registry to merge and later load skills. */
export interface SkillCandidate extends SkillSummary {
  /** Lower ranks win duplicate skill names before provider registration order is considered. */
  readonly rank: number
  /** Opaque provider-owned handle passed back to `provider.get()`. */
  readonly locator: unknown
  /** Absolute file path when the provider has one. */
  readonly path?: string
  /** Parsed optional metadata object from provider-specific skill frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Complete parsed skill definition, including the body loaded by `ctx.skills.get()`. */
export interface SkillDefinition extends SkillSummary {
  /** Markdown instruction body after any provider-specific metadata removal. */
  readonly content: string
  /** Absolute file path when the skill came from disk. */
  readonly path?: string
  /** Parsed optional metadata object from frontmatter. */
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Runtime skill contribution accepted by `ctx.skills.register()`. */
export type SkillRegistration = Omit<SkillDefinition, 'provider'> & { readonly provider?: string }

/** Caller context used for cwd-sensitive and abortable provider work. */
export interface SkillLookupOptions {
  /** Workspace selector for the current lookup. */
  readonly cwd?: string | undefined
  /** Abort discovery or loading work for the current caller. */
  readonly signal?: AbortSignal | undefined
}

/** Provider interface for one source of skills, such as local directories or a remote registry. */
export interface SkillProvider {
  /** Unique provider name in the `ctx.skills` registry. */
  readonly name: string
  /**
   * List available skill candidates for the current lookup context. Provider
   * plugins register synchronously during `apply()`; remote initialization,
   * authentication, and discovery are awaited inside this method. Implementations
   * should settle promptly when `options.signal` aborts.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns provider candidates with precedence ranks and opaque locators.
   */
  readonly list: (options: SkillLookupOptions) => Promise<readonly SkillCandidate[]>
  /**
   * Load a complete skill body for a previously listed candidate.
   * @param candidate - the winning candidate originally returned by this provider.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns the full skill body, or `undefined` if it is no longer loadable.
   */
  readonly get: (candidate: SkillCandidate, options: SkillLookupOptions) => Promise<SkillDefinition | undefined>
}

/** Skill registry configuration. */
export interface Config {
  /** Maximum number of completed cwd/provider catalogs kept in memory. */
  readonly collectCacheMaxEntries?: number
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
  private readonly runtime = new Map<string, SkillRegistration>()
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
   * Register a borrowed same-process provider synchronously during plugin apply. Duplicate and
   * reserved names throw; remote initialization belongs in `list()`. Fiber disposal unregisters
   * the provider and invalidates catalog caches.
   * @param provider - the provider to register by `provider.name`.
   * @returns the exact Cordis effect disposer that unregisters this provider;
   *   composite effects may yield it directly to preserve teardown ordering.
   */
  registerProvider(provider: SkillProvider): () => void {
    const name = provider.name
    if (name === RUNTIME_PROVIDER) {
      throw new Error(`"${RUNTIME_PROVIDER}" is reserved for runtime skill registrations`)
    }
    if (this.providers.has(name)) {
      throw new Error(`a skill provider named "${name}" is already registered`)
    }
    const providers = this.providers
    const ctx = this.ctx
    const order = this.nextProviderOrder
    const invalidateCache = (): void => { this.invalidateCache() }
    this.nextProviderOrder += 1
    const dispose = ctx.effect(function* () {
      providers.set(name, { provider, order })
      invalidateCache()
      yield () => {
        providers.delete(name)
        invalidateCache()
        ctx.emit('skill/provider-removed', name)
      }
      ctx.emit('skill/provider-added', provider)
    }, 'skills.registerProvider()')
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /**
   * Register a borrowed readonly runtime skill. Project entries outrank runtime entries, which
   * outrank user entries. Same-name runtime entries are first-wins; a duplicate logs a warning and
   * receives a no-op disposer so it cannot remove the winner.
   * @param skill - the complete skill definition to expose for discovery.
   * @returns the exact Cordis effect disposer, preserving composite teardown order and invalidating caches.
   */
  register(skill: SkillRegistration): () => void {
    validateRuntimeSkill(skill)
    const existing = this.runtime.get(skill.name)
    if (existing !== undefined) {
      this.ctx.logger.warn(`runtime skill "${skill.name}" ignored because it is already registered`)
      return () => {}
    }
    const runtime = this.runtime
    const updateRevision = (): void => { this.runtimeRevision += 1 }
    const invalidateCache = (): void => { this.invalidateCache() }
    const dispose = this.ctx.effect(function* () {
      runtime.set(skill.name, skill)
      updateRevision()
      invalidateCache()
      yield () => {
        runtime.delete(skill.name)
        updateRevision()
        invalidateCache()
      }
    }, 'skills.register()')
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- synchronous cleanup; direct return preserves disposer identity
    return dispose
  }

  /**
   * List model-invocable skill summaries for a workspace. Lookup options and
   * provider candidates are readonly same-process values borrowed throughout
   * discovery.
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
   * Load and validate the winning candidate, passing its opaque discovery locator back to the
   * provider. Cancellation is rechecked after selection, including cache hits, and raced against
   * loading so an uncooperative provider cannot hang the caller.
   * @param name - kebab-case skill name.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns the full skill, including body content, or `undefined`.
   */
  async get(name: string, options: SkillLookupOptions = {}): Promise<SkillDefinition | undefined> {
    if (!isSkillName(name)) return undefined
    const collected = await this.collect(options)
    throwIfAborted(options.signal)
    const match = collected.find(entry => entry.candidate.name === name)
    if (match === undefined) return undefined
    const definition = await waitWithAbort(
      match.provider.get(match.candidate, options),
      options.signal,
    )
    if (definition === undefined) return undefined
    validateDefinition(definition)
    return definition
  }

  private async collect(options: SkillLookupOptions): Promise<IndexedCandidate[]> {
    throwIfAborted(options.signal)
    while (true) {
      const providerRevision = this.providerRevision
      const runtimeRevision = this.runtimeRevision
      const key = collectCacheKey(options, providerRevision, runtimeRevision)
      const cached = this.collectCache.get(key)
      if (cached !== undefined) return cached

      const result = await this.collectFresh(options)
      throwIfAborted(options.signal)
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
    throwIfAborted(options.signal)
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
      let output: unknown
      try {
        output = await waitWithAbort(provider.list(options), options.signal)
      } catch (error) {
        if (options.signal?.aborted === true) throw toError(options.signal.reason)
        cacheable = false
        this.ctx.logger.warn(`skill provider "${provider.name}" skipped: ${errorMessage(error)}`)
      }
      if (output === undefined) continue
      if (!Array.isArray(output)) {
        throw new TypeError(`skill provider "${provider.name}" list() must return an array`)
      }
      const listed = output as readonly SkillCandidate[]
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
    const skill = candidate.locator as SkillRegistration
    return Promise.resolve({ ...skill, provider: skill.provider ?? RUNTIME_PROVIDER })
  },
}

function runtimeCandidate(skill: SkillRegistration): SkillCandidate {
  return {
    name: skill.name,
    description: skill.description,
    ...skill.whenToUse !== undefined ? { whenToUse: skill.whenToUse } : {},
    ...skill.disableModelInvocation !== undefined ? { disableModelInvocation: skill.disableModelInvocation } : {},
    source: skill.source,
    provider: skill.provider ?? RUNTIME_PROVIDER,
    ...skill.resourceBase !== undefined ? { resourceBase: skill.resourceBase } : {},
    rank: RUNTIME_RANK,
    locator: skill,
    ...skill.path !== undefined ? { path: skill.path } : {},
    ...skill.metadata !== undefined ? { metadata: skill.metadata } : {},
  }
}

function validateCandidate(candidate: SkillCandidate, providerName: string): void {
  if (typeof candidate.name !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned a non-string skill name`)
  }
  if (!SKILL_NAME.test(candidate.name)) {
    throw new Error(`skill provider "${providerName}" returned invalid skill name "${candidate.name}"`)
  }
  if (typeof candidate.description !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned skill "${candidate.name}" with a non-string description`)
  }
  if (candidate.description.length === 0) {
    throw new Error(`skill provider "${providerName}" returned skill "${candidate.name}" without a description`)
  }
  if (candidate.disableModelInvocation !== undefined && typeof candidate.disableModelInvocation !== 'boolean') {
    throw new TypeError(`skill provider "${providerName}" returned skill "${candidate.name}" with a non-boolean disableModelInvocation`)
  }
  if (candidate.whenToUse !== undefined && typeof candidate.whenToUse !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned skill "${candidate.name}" with a non-string whenToUse`)
  }
  if (typeof candidate.source !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned skill "${candidate.name}" with a non-string source`)
  }
  if (typeof candidate.rank !== 'number' || !Number.isFinite(candidate.rank)) {
    throw new Error(`skill provider "${providerName}" returned skill "${candidate.name}" with an invalid rank`)
  }
  if (typeof candidate.provider !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned skill "${candidate.name}" with a non-string provider`)
  }
  if (candidate.provider !== providerName) {
    throw new Error(`skill provider "${providerName}" returned skill "${candidate.name}" for provider "${candidate.provider}"`)
  }
  if (candidate.path !== undefined && typeof candidate.path !== 'string') {
    throw new TypeError(`skill provider "${providerName}" returned skill "${candidate.name}" with a non-string path`)
  }
}

function validateRuntimeSkill(skill: SkillRegistration): void {
  if (!SKILL_NAME.test(skill.name)) throw new Error(`invalid skill name "${skill.name}"`)
  if (skill.description.length === 0) throw new Error(`skill "${skill.name}" requires a description`)
}

/** Validate a definition loaded from a provider-controlled parser or remote source. */
function validateDefinition(skill: SkillDefinition): void {
  const name = skill.name
  const description = skill.description
  const whenToUse = skill.whenToUse
  const disableModelInvocation = skill.disableModelInvocation
  const source = skill.source
  const provider = skill.provider
  const content = skill.content
  const path = skill.path
  if (typeof name !== 'string') throw new TypeError('loaded skill name must be a string')
  if (!SKILL_NAME.test(name)) throw new Error(`loaded skill has invalid name "${name}"`)
  if (typeof description !== 'string') throw new TypeError(`loaded skill "${name}" description must be a string`)
  if (description.length === 0) throw new Error(`loaded skill "${name}" requires a description`)
  if (disableModelInvocation !== undefined && typeof disableModelInvocation !== 'boolean') {
    throw new TypeError(`loaded skill "${name}" disableModelInvocation must be a boolean`)
  }
  if (whenToUse !== undefined && typeof whenToUse !== 'string') throw new TypeError(`loaded skill "${name}" whenToUse must be a string`)
  if (typeof source !== 'string') throw new TypeError(`loaded skill "${name}" source must be a string`)
  if (typeof provider !== 'string') throw new TypeError(`loaded skill "${name}" provider must be a string`)
  if (typeof content !== 'string') throw new TypeError(`loaded skill "${name}" content must be a string`)
  if (path !== undefined && typeof path !== 'string') throw new TypeError(`loaded skill "${name}" path must be a string`)
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
  throwIfAborted(signal)
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
  })
}

/** Throw a total Error for an already-aborted lookup. */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw toError(signal.reason)
}

/** Normalize an arbitrary abort or provider failure without trusting coercion. */
function toError(error: unknown): Error {
  try {
    if (error instanceof Error) return error
  } catch {
    // A hostile proxy may throw during instanceof; fall through to the total renderer.
  }
  return new Error(errorMessage(error))
}

/** Render an arbitrary provider failure without letting coercion escape containment. */
function errorMessage(error: unknown): string {
  try {
    return String(error)
  } catch {
    return '[unrenderable thrown value]'
  }
}

export default SkillService
