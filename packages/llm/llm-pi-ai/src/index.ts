/**
 * Generic pi-ai-backed LLM adapter plugin. One plugin instance owns a dict of
 * provider routes; requests select a profile by provider and resolve the
 * model dynamically from pi-ai's installed catalog. Profile facts resolve per
 * request over the optional `llm-pi-ai` user-settings section and the
 * optional credential seam, so a changed key, endpoint, or request knob
 * reaches the next request without a restart. Provider routes and retry
 * policies stay composition-fixed.
 *
 * ```yaml
 * - id: llm
 *   name: '@deepseek-ai/dsh-llm-pi-ai'
 *   config:
 *     providers:
 *       openai:
 *         apiKeyEnv: OPENAI_API_KEY
 *         retryPolicy:
 *           mode: normal
 *           maxRetries: 2
 *       anthropic:
 *         apiKeyEnv: ANTHROPIC_API_KEY
 *       openrouter:
 *         apiKeyEnv: OPENROUTER_API_KEY
 *         baseURL: https://proxy.example.com/v1
 * ```
 *
 * @module @deepseek-ai/dsh-llm-pi-ai
 */

import type { Context } from 'cordis'
import { LlmError } from '@deepseek-ai/dsh-llm'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { PiAiAdapter } from './adapter.ts'
import { Config, resolveProfiles } from './config.ts'
import type { ResolvedPiAiProviderProfile } from './config.ts'

export { PiAiAdapter } from './adapter.ts'
export type { PiAiAdapterOptions } from './adapter.ts'
export { Config } from './config.ts'
export type { PiAiProviderProfile, ResolvedPiAiProviderProfile } from './config.ts'

export const name = 'llm-pi-ai'
export const inject = ['llm']

const NS = settingsNamespace('llm-pi-ai')

/**
 * The registry captures these per route; a change here must re-register.
 * Sorted by provider so a settings document that merely reorders its keys is
 * not mistaken for a route change.
 */
function registrationFacts(profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>): unknown {
  return [...profiles.entries()]
    .map(([provider, profile]) => ({ provider, retryPolicy: profile.retryPolicy }))
    .sort((left, right) => left.provider.localeCompare(right.provider))
}

/** Register one generic pi-ai adapter for all configured provider routes. */
export function apply(ctx: Context, config: Config): void {
  const compositionProfiles = resolveProfiles(config.providers)
  const compositionFacts = registrationFacts(compositionProfiles)
  let current: () => Config = () => config
  let lastRaw: Config = config
  let lastGood: ReadonlyMap<string, ResolvedPiAiProviderProfile> = compositionProfiles
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const raw = current()
    if (raw === lastRaw) return lastGood
    try {
      const next = resolveProfiles(raw.providers)
      if (!deepEqualJson(registrationFacts(next), compositionFacts)) {
        throw new Error('llm-pi-ai: provider routes and retry policies are composition-fixed')
      }
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing catalog or bound checks:
      // keep serving the last good profiles and say so once per bad snapshot.
      lastRaw = raw
      ctx.logger.error('llm-pi-ai: keeping the last good profiles after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }

  const resolveApiKey = async (
    provider: string,
    profile: ResolvedPiAiProviderProfile,
  ): Promise<string | undefined> => {
    if (profile.apiKey !== undefined) return profile.apiKey
    const ref = profile.apiKeyEnv
    // Only a profile that names no credential at all defers to pi-ai's
    // provider-native discovery. Once one is named, a miss must fail loud:
    // handing pi-ai `undefined` would let it pick up an unrelated ambient key
    // (OPENAI_API_KEY and friends), billing another tenant for a request the
    // deployment meant to authenticate differently.
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    const hit = credentials !== undefined
      ? await credentials.resolve(ref)
      // Without the seam, read exactly the named variable so a plain
      // cordis.yml composition works from the environment alone.
      : process.env[ref]
    if (hit !== undefined && hit.length > 0) return hit
    throw new LlmError(
      `llm-pi-ai: no credential for provider route "${provider}"; its profile resolves ${ref}, which is not`
      + ` set — provide ${ref} through the credential provider or launching environment,`
      + ' and remove apiKeyEnv only if this provider should authenticate from pi-ai\'s own environment discovery',
      'MISSING_CREDENTIAL',
    )
  }

  const adapter = new PiAiAdapter({ profiles, resolveApiKey })
  ctx.llm.registerAdapter([...compositionProfiles.keys()], adapter)

  installSettingsSection(ctx, NS, Config, config, {
    setSource: (source) => {
      current = source
    },
  })
}
