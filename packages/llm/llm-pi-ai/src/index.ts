/**
 * Generic pi-ai-backed LLM adapter plugin. One plugin instance owns a dict of
 * provider routes; requests select a profile by provider and resolve the
 * model dynamically from pi-ai's installed catalog. Profile facts resolve per
 * request over the optional `llm-pi-ai` user-settings section and the
 * optional credential seam, so a changed key, endpoint, or knob reaches the
 * next request without a restart; a changed *route set* (or a route's
 * registration-captured retry policy) re-registers the same adapter instance
 * in place.
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
import type {} from '@deepseek-ai/dsh-llm'
import { deepEqualJson, settingsNamespace } from '@deepseek-ai/dsh-settings'
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

/** The registry captures these per route; a change here must re-register. */
function registrationFacts(profiles: ReadonlyMap<string, ResolvedPiAiProviderProfile>): unknown {
  return [...profiles.entries()].map(([provider, profile]) => ({ provider, retryPolicy: profile.retryPolicy }))
}

/** Register one generic pi-ai adapter for all configured provider routes. */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ReadonlyMap<string, ResolvedPiAiProviderProfile> | undefined
  const profiles = (): ReadonlyMap<string, ResolvedPiAiProviderProfile> => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveProfiles(raw.providers)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      // Static composition resolves before anything registers, so this branch
      // only sees a live settings snapshot failing catalog or bound checks:
      // keep serving the last good profiles and say so once per bad snapshot.
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-pi-ai: keeping the last good profiles after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
    }
  }
  profiles()

  const resolveApiKey = async (profile: ResolvedPiAiProviderProfile): Promise<string | undefined> => {
    if (profile.apiKey !== undefined) return profile.apiKey
    const ref = profile.apiKeyEnv
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) return (await credentials.resolve(ref))?.value
    // Without the seam, keep an ambient fallback so a plain cordis.yml
    // composition works from the environment alone; an empty variable defers
    // to pi-ai's own provider-native discovery like an absent one.
    const ambient = process.env[ref]
    return ambient !== undefined && ambient.length > 0 ? ambient : undefined
  }

  const adapter = new PiAiAdapter({ profiles, resolveApiKey })
  // Route effects bind to this apply fiber via the stable `ctx` reference,
  // even when a swap runs inside the scoped settings callback below.
  let disposeRoutes = ctx.llm.registerAdapter([...profiles().keys()], adapter)
  let registeredFacts = registrationFacts(profiles())
  const ensureRegistrationFacts = (): void => {
    const facts = registrationFacts(profiles())
    if (deepEqualJson(facts, registeredFacts)) return
    // The registry captures the route set and each route's retry policy at
    // registration: swap the registration in one synchronous section (same
    // adapter instance, no NO_ADAPTER window).
    disposeRoutes()
    disposeRoutes = ctx.llm.registerAdapter([...profiles().keys()], adapter)
    registeredFacts = facts
  }

  ctx.inject(['settings'], (sctx) => {
    const scope = sctx.settings.register(NS, Config, { base: config })
    current = () => scope.get()
    sctx.effect(() => () => {
      // Settings detached (provider disposed or reloading): fall back to the
      // composition entry so the plugin keeps working exactly as configured.
      current = () => config
      ensureRegistrationFacts()
    })
    ensureRegistrationFacts()
    scope.watch(() => {
      ensureRegistrationFacts()
    })
  })
}
