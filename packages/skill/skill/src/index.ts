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
  /** Workspace selector captured at lookup entry; providers receive a read-only snapshot. */
  readonly cwd?: string | undefined
  /** Abort discovery or loading work for the current caller. */
  readonly signal?: AbortSignal | undefined
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
   * @param candidate - a detached snapshot of the winning candidate; its opaque
   *   `locator` retains the exact identity originally returned by this provider.
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
   * initialization do that work inside `list()` after registration. The name
   * and callback identities are snapshotted at registration, so later
   * replacement of those fields cannot change the registry key, dispatch
   * callbacks, or HMR cleanup identity. Bound callbacks retain the original
   * provider object as their receiver, so provider-owned mutable state remains
   * live. Effect-scoped and HMR-safe: disposing the caller's fiber unregisters
   * the provider and invalidates cached catalogs.
   * @param provider - the provider to register by `provider.name`.
   * @returns the exact Cordis effect disposer that unregisters this provider;
   *   composite effects may yield it directly to preserve teardown ordering.
   */
  registerProvider(provider: SkillProvider): () => Promise<void> | void {
    // Snapshot the registration contract before entering the effect. The
    // callback binding preserves the historical method receiver while making
    // replacement of `provider.list`/`provider.get` after registration inert.
    // In particular, cleanup must never re-read caller-owned `provider.name`:
    // an HMR host may mutate or reuse that object before its old fiber unloads.
    const name = provider.name
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const inputList = provider.list
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const inputGet = provider.get
    if (typeof name !== 'string') throw new TypeError('skill provider name must be a string')
    if (typeof inputList !== 'function') throw new TypeError(`skill provider "${name}" list must be a function`)
    if (typeof inputGet !== 'function') throw new TypeError(`skill provider "${name}" get must be a function`)
    const snapshot: SkillProvider = Object.freeze({
      name,
      list: inputList.bind(provider),
      get: inputGet.bind(provider),
    })
    const dispose = this.ctx.effect(function* (this: SkillService) {
      if (snapshot.name === RUNTIME_PROVIDER) {
        throw new Error(`"${RUNTIME_PROVIDER}" is reserved for runtime skill registrations`)
      }
      if (this.providers.has(snapshot.name)) {
        throw new Error(`a skill provider named "${snapshot.name}" is already registered`)
      }
      this.providers.set(snapshot.name, { provider: snapshot, order: this.nextProviderOrder })
      this.nextProviderOrder += 1
      this.invalidateCache()
      yield () => {
        this.providers.delete(snapshot.name)
        this.invalidateCache()
        this.ctx.emit('skill/provider-removed', snapshot.name)
      }
      this.ctx.emit('skill/provider-added', snapshot)
    }.bind(this), 'skills.registerProvider()')
    return dispose
  }

  /**
   * Register a runtime skill contribution. Runtime registrations are treated as
   * embedded provider entries with project-over-user priority. Same-name runtime
   * registrations are first-wins: a duplicate logs a warning and gets a no-op
   * disposer so it cannot remove the active contribution. The registry detaches
   * the accepted definition, including nested resource metadata, so later caller
   * mutation cannot rewrite the live contribution.
   * @param skill - the complete skill definition to expose for discovery.
   * @returns the exact Cordis effect disposer that removes this runtime
   *   contribution and invalidates caches; composite effects may yield it
   *   directly to preserve teardown ordering.
   */
  register(skill: SkillRegistration): () => Promise<void> | void {
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
    return dispose
  }

  /**
   * List model-invocable skill summaries for a workspace. The lookup options are
   * snapshotted before discovery, and every returned summary is detached from the
   * cached provider catalog.
   * @param options - lookup options; `cwd` selects project roots and `signal` cancels discovery.
   * @returns sorted summaries, excluding skills disabled for model invocation.
   */
  async list(options: SkillLookupOptions = {}): Promise<SkillSummary[]> {
    const accepted = snapshotLookupOptions(options)
    return (await this.collect(accepted))
      .map(entry => entry.candidate)
      .filter(skill => skill.disableModelInvocation !== true)
      .map(toSummary)
      .sort(compareSkillSummary)
  }

  /**
   * Load one full skill definition by name. One lookup-options snapshot selects
   * and loads the winner; the provider receives detached candidate metadata with
   * its opaque locator identity preserved, and the returned definition is also
   * detached from provider-owned data. Cancellation is rechecked after catalog
   * selection (including a cache hit), and provider loading is raced against the
   * same signal so an uncooperative provider cannot hang the caller.
   * @param name - kebab-case skill name.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills and `signal` cancels work.
   * @returns the full skill, including body content, or `undefined`.
   */
  async get(name: string, options: SkillLookupOptions = {}): Promise<SkillDefinition | undefined> {
    if (!isSkillName(name)) return undefined
    const accepted = snapshotLookupOptions(options)
    const collected = await this.collect(accepted)
    throwIfAborted(accepted.signal)
    const match = collected.find(entry => entry.candidate.name === name)
    if (match === undefined) return undefined
    const definition = await waitWithAbort(
      match.provider.get(copyCandidate(match.candidate), accepted),
      accepted.signal,
    )
    return definition === undefined ? undefined : snapshotDefinition(definition)
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
      let listed: SkillCandidate[] | undefined
      try {
        listed = await waitWithAbort(provider.list(options), options.signal)
      } catch (error) {
        if (options.signal?.aborted === true) throw toError(options.signal.reason)
        cacheable = false
        this.ctx.logger.warn(`skill provider "${provider.name}" skipped: ${errorMessage(error)}`)
      }
      if (listed === undefined) continue
      if (!Array.isArray(listed)) {
        throw new TypeError(`skill provider "${provider.name}" list() must return an array`)
      }
      for (const candidate of listed) {
        const snapshot = snapshotCandidate(candidate, provider.name)
        candidates.push({ candidate: snapshot, provider, providerOrder: order, localOrder })
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

/** Read provider candidate data once and detach it while preserving its opaque locator identity. */
function copyCandidate(candidate: SkillCandidate, providerName?: string): SkillCandidate {
  const name = candidate.name
  const description = candidate.description
  const whenToUse = candidate.whenToUse
  const disableModelInvocation = candidate.disableModelInvocation
  const source = candidate.source
  const provider = candidate.provider
  const resourceBase = candidate.resourceBase
  const rank = candidate.rank
  const locator = candidate.locator
  const path = candidate.path
  const metadata = candidate.metadata
  const accepted: SkillCandidate = {
    name,
    description,
    ...whenToUse !== undefined ? { whenToUse } : {},
    ...disableModelInvocation !== undefined ? { disableModelInvocation } : {},
    source,
    provider,
    ...resourceBase !== undefined ? { resourceBase } : {},
    rank,
    // `locator` is the one deliberately provider-owned capability in a
    // candidate. Its exact identity must round-trip back to provider.get().
    locator,
    ...path !== undefined ? { path } : {},
    ...metadata !== undefined ? { metadata } : {},
  }
  // Validate the exact scalar snapshot before cloning nested data. This keeps a
  // malformed candidate's provider-contract error from being masked by an
  // unrelated DataCloneError in its metadata.
  if (providerName !== undefined) validateCandidate(accepted, providerName)
  return {
    ...accepted,
    ...resourceBase !== undefined ? { resourceBase: structuredClone(resourceBase) } : {},
    ...metadata !== undefined ? { metadata: structuredClone(metadata) } : {},
  }
}

/** Normalize one provider result into the registry-owned catalog snapshot. */
function snapshotCandidate(candidate: SkillCandidate, providerName: string): SkillCandidate {
  return copyCandidate(candidate, providerName)
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

function normalizeRuntimeSkill(skill: SkillRegistration): SkillDefinition {
  // Read every caller-owned top-level field once so validation and storage use
  // one coherent definition even when JavaScript accessors are involved.
  const name = skill.name
  const description = skill.description
  const whenToUse = skill.whenToUse
  const disableModelInvocation = skill.disableModelInvocation
  const source = skill.source
  const inputProvider = skill.provider
  const provider = inputProvider === undefined ? RUNTIME_PROVIDER : inputProvider
  const resourceBase = skill.resourceBase
  const content = skill.content
  const path = skill.path
  const metadata = skill.metadata
  if (typeof name !== 'string') throw new TypeError('runtime skill name must be a string')
  if (!SKILL_NAME.test(name)) throw new Error(`invalid skill name "${name}"`)
  if (typeof description !== 'string') throw new TypeError(`skill "${name}" description must be a string`)
  if (description.length === 0) throw new Error(`skill "${name}" requires a description`)
  if (disableModelInvocation !== undefined && typeof disableModelInvocation !== 'boolean') {
    throw new TypeError(`skill "${name}" disableModelInvocation must be a boolean`)
  }
  if (whenToUse !== undefined && typeof whenToUse !== 'string') throw new TypeError(`skill "${name}" whenToUse must be a string`)
  if (typeof source !== 'string') throw new TypeError(`skill "${name}" source must be a string`)
  if (typeof provider !== 'string') throw new TypeError(`skill "${name}" provider must be a string`)
  if (typeof content !== 'string') throw new TypeError(`skill "${name}" content must be a string`)
  if (path !== undefined && typeof path !== 'string') throw new TypeError(`skill "${name}" path must be a string`)
  return {
    name,
    description,
    ...whenToUse !== undefined ? { whenToUse } : {},
    ...disableModelInvocation !== undefined ? { disableModelInvocation } : {},
    source,
    provider,
    ...resourceBase !== undefined ? { resourceBase: structuredClone(resourceBase) } : {},
    content,
    ...path !== undefined ? { path } : {},
    ...metadata !== undefined ? { metadata: structuredClone(metadata) } : {},
  }
}

/** Detach a provider-loaded definition before it crosses back to the caller. */
function snapshotDefinition(skill: SkillDefinition): SkillDefinition {
  const name = skill.name
  const description = skill.description
  const whenToUse = skill.whenToUse
  const disableModelInvocation = skill.disableModelInvocation
  const source = skill.source
  const provider = skill.provider
  const resourceBase = skill.resourceBase
  const content = skill.content
  const path = skill.path
  const metadata = skill.metadata
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
  return {
    name,
    description,
    ...whenToUse !== undefined ? { whenToUse } : {},
    ...disableModelInvocation !== undefined ? { disableModelInvocation } : {},
    source,
    provider,
    ...resourceBase !== undefined ? { resourceBase: structuredClone(resourceBase) } : {},
    content,
    ...path !== undefined ? { path } : {},
    ...metadata !== undefined ? { metadata: structuredClone(metadata) } : {},
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
    ...resourceBase !== undefined ? { resourceBase: structuredClone(resourceBase) } : {},
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

/** Capture one lookup identity before any provider or cache async boundary. */
function snapshotLookupOptions(options: SkillLookupOptions): Readonly<SkillLookupOptions> {
  const cwd = options.cwd
  const signal = options.signal
  return Object.freeze({
    ...cwd !== undefined ? { cwd } : {},
    ...signal !== undefined ? { signal } : {},
  })
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
    if (signal.aborted) onAbort()
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
