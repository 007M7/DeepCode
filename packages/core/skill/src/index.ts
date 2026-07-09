/**
 * Agent skill registry and request-time catalog rendering.
 *
 * This package is the interface third of the skill capability seam. Concrete
 * providers such as `@deepseek-ai/dsh-skill-local` decide where skills come
 * from; this service only merges provider catalogs, resolves the winning skill
 * for a name, and exposes the model-facing catalog/tool consumers use.
 *
 * @module @deepseek-ai/dsh-skill
 */

import { Context, Service } from 'cordis'
import z from 'schemastery'
import type Schema from 'schemastery'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-agent'

const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const DEFAULT_PROMPT_FIELD_LENGTH = 500
const DEFAULT_COLLECT_CACHE_ENTRIES = 128
const RUNTIME_PROVIDER = 'runtime'
const RUNTIME_RANK = 250
const SKILL_PROMPT_SECTION_ORDER = 1000

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

/** Workspace selector used for cwd-sensitive provider discovery. */
export interface SkillLookupOptions {
  cwd?: string | undefined
}

/** Provider interface for one source of skills, such as local directories or a remote registry. */
export interface SkillProvider {
  /** Unique provider name in the `ctx.skills` registry. */
  name: string
  /**
   * List available skill candidates for the current lookup context.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills.
   * @returns provider candidates with precedence ranks and opaque locators.
   */
  list(options: SkillLookupOptions): Promise<SkillCandidate[]>
  /**
   * Load a complete skill body for a previously listed candidate.
   * @param candidate - the winning candidate originally returned by this provider.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills.
   * @returns the full skill body, or `undefined` if it is no longer loadable.
   */
  get(candidate: SkillCandidate, options: SkillLookupOptions): Promise<SkillDefinition | undefined>
}

/** Skill registry configuration. */
export interface Config {
  /** Maximum rendered description/whenToUse length in the prompt listing; minimum 3. */
  promptFieldMaxLength?: number
  /** Maximum number of cwd/provider discovery promises kept in the in-memory cache. */
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
 * first-wins duplicate handling, exposes sorted model-visible summaries, loads
 * full skill bodies on demand, and renders the request-time catalog fragment.
 */
export class SkillService extends Service {
  static Config: Schema<Config> = z.object({
    promptFieldMaxLength: z.number().default(DEFAULT_PROMPT_FIELD_LENGTH),
    collectCacheMaxEntries: z.number().default(DEFAULT_COLLECT_CACHE_ENTRIES),
  })

  private readonly promptFieldMaxLength: number
  private readonly collectCacheMaxEntries: number
  private readonly providers = new Map<string, { provider: SkillProvider; order: number }>()
  private readonly runtime = new Map<string, SkillDefinition>()
  private readonly collectCache = new Map<string, Promise<IndexedCandidate[]>>()
  private providerRevision = 0
  private nextProviderOrder = 0
  private runtimeRevision = 0

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'skills')
    this.promptFieldMaxLength = config.promptFieldMaxLength ?? DEFAULT_PROMPT_FIELD_LENGTH
    this.collectCacheMaxEntries = config.collectCacheMaxEntries ?? DEFAULT_COLLECT_CACHE_ENTRIES
    assertPositiveInteger('promptFieldMaxLength', this.promptFieldMaxLength, 3)
    assertPositiveInteger('collectCacheMaxEntries', this.collectCacheMaxEntries)

    ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
      const result = await next()
      const agent = context.agent
      if (agent === undefined) return result
      const listing = await this.renderModelListing({ cwd: agent.session.header.cwd })
      if (listing.length > 0) {
        result.sections.push({
          name: 'skills:available',
          order: SKILL_PROMPT_SECTION_ORDER,
          text: listing,
        })
      }
      return result
    })
  }

  /**
   * Register a skill provider. Throws if another provider already owns the same
   * provider name, including the reserved runtime provider name. Effect-scoped
   * and HMR-safe: disposing the caller's fiber unregisters the provider and
   * invalidates cached catalogs.
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
   * @param options - lookup options; `cwd` selects the project roots to scan.
   * @returns sorted summaries, excluding skills disabled for model invocation.
   */
  async list(options: SkillLookupOptions = {}): Promise<SkillSummary[]> {
    return (await this.collect(options))
      .map(entry => entry.candidate)
      .filter(skill => skill.disableModelInvocation !== true)
      .map(toSummary)
      .sort(compareSummary)
  }

  /**
   * Load one full skill definition by name.
   * @param name - kebab-case skill name.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills.
   * @returns the full skill, including body content, or `undefined`.
   */
  async get(name: string, options: SkillLookupOptions = {}): Promise<SkillDefinition | undefined> {
    if (!isSkillName(name)) return undefined
    const match = (await this.collect(options)).find(entry => entry.candidate.name === name)
    if (match === undefined) return undefined
    return await match.provider.get(match.candidate, options)
  }

  /**
   * Render the request-time `## Skills` prompt fragment.
   * @param options - lookup options; `cwd` selects workspace-sensitive skills.
   * @returns an empty string when no model-invocable skills are available.
   */
  async renderModelListing(options: SkillLookupOptions = {}): Promise<string> {
    const skills = await this.list(options)
    if (skills.length === 0) return ''
    const entries = skills.map((skill) => {
      const lines = [
        `<skill name="${escapeAttr(skill.name)}" source="${escapeAttr(skill.source)}">`,
        `description: ${promptLine(skill.description, this.promptFieldMaxLength)}`,
        ...skill.whenToUse ? [`whenToUse: ${promptLine(skill.whenToUse, this.promptFieldMaxLength)}`] : [],
        '</skill>',
      ]
      return lines.join('\n')
    }).join('\n')
    return [
      '## Skills',
      'Available skills are listed below. Load a skill with the `skill` tool before following its instructions; do not infer or follow instructions from a skill body that has not been loaded.',
      '<available_skills>',
      entries,
      '</available_skills>',
    ].join('\n')
  }

  private async collect(options: SkillLookupOptions): Promise<IndexedCandidate[]> {
    const key = collectCacheKey(options, this.providerRevision, this.runtimeRevision)
    const cached = this.collectCache.get(key)
    if (cached !== undefined) return cached

    const collected = this.collectFresh(options)
    const cachedPromise = collected.then((result) => {
      if (!result.cacheable) this.collectCache.delete(key)
      return result.entries
    }).catch((error: unknown) => {
      this.collectCache.delete(key)
      throw error
    })
    this.collectCache.set(key, cachedPromise)
    if (this.collectCache.size > this.collectCacheMaxEntries) {
      const oldest = this.collectCache.keys().next() as IteratorYieldResult<string>
      this.collectCache.delete(oldest.value)
    }
    return cachedPromise
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
    const candidates: IndexedCandidate[] = []
    let cacheable = true
    let runtimeOrder = 0
    for (const skill of [...this.runtime.values()].sort((a, b) => a.name.localeCompare(b.name))) {
      candidates.push({
        candidate: runtimeCandidate(skill),
        provider: RUNTIME_SKILL_PROVIDER,
        providerOrder: -1,
        localOrder: runtimeOrder,
      })
      runtimeOrder += 1
    }
    for (const { provider, order } of this.providers.values()) {
      let localOrder = 0
      const listed = await provider.list(options).catch((error: unknown) => {
        cacheable = false
        this.ctx.logger.warn(`skill provider "${provider.name}" skipped: ${errorMessage(error)}`)
        return undefined
      })
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

function compareSummary(left: SkillSummary, right: SkillSummary): number {
  return left.name.localeCompare(right.name)
}

function compareIndexedCandidates(left: IndexedCandidate, right: IndexedCandidate): number {
  return left.candidate.rank - right.candidate.rank
    || left.providerOrder - right.providerOrder
    || left.localOrder - right.localOrder
}

function promptLine(value: string, maxLength: number): string {
  const normalized = value.replaceAll(/\s+/g, ' ').trim()
  const truncated = normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 3)}...`
  return escapeText(breakPromptTemplateDelimiters(truncated))
}

function breakPromptTemplateDelimiters(value: string): string {
  return value.replaceAll('{{', '{ {').replaceAll('}}', '} }')
}

function assertPositiveInteger(name: string, value: number, minimum = 1): void {
  if (!Number.isInteger(value) || value < minimum) {
    throw new Error(`skill: ${name} must be an integer greater than or equal to ${minimum}`)
  }
}

function escapeAttr(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;')
}

function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

function collectCacheKey(options: SkillLookupOptions, providerRevision: number, runtimeRevision: number): string {
  return JSON.stringify({ cwd: options.cwd, providerRevision, runtimeRevision })
}

function errorMessage(error: unknown): string {
  return String(error)
}

export default SkillService
