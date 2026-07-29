/** resolveLlmRoute: layered provider/model resolution and the dynamic pi-ai mount decision. */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseIncludeYmlRows, resolveLlmRoute, ymlPiAiProvidersOf } from '../src/app-cli-entry.ts'

/** The shipped yml shape: DeepSeek gateway default plus a pi-ai row routing openai/anthropic. */
const SHIPPED = {
  gateway: { provider: 'deepseek', model: 'deepseek-v4-flash' },
  ymlPiAiProviders: ['openai', 'anthropic'],
}

describe('resolveLlmRoute', () => {
  it('keeps the DeepSeek default without any dynamic mount', () => {
    expect(resolveLlmRoute({ cli: {}, profile: {}, ...SHIPPED }))
      .toEqual({ provider: 'deepseek', dynamicPiAiProvider: undefined })
  })

  it('reuses the yml pi-ai row for providers it already routes (no duplicate adapter)', () => {
    expect(resolveLlmRoute({
      cli: { provider: 'anthropic', model: 'claude-opus-4-8' }, profile: {}, ...SHIPPED,
    })).toEqual({ provider: 'anthropic', dynamicPiAiProvider: undefined })
  })

  it('mounts pi-ai dynamically only for providers absent from the yml row', () => {
    expect(resolveLlmRoute({
      cli: { provider: 'google', model: 'gemini-3-pro' }, profile: {}, ...SHIPPED,
    })).toEqual({ provider: 'google', dynamicPiAiProvider: 'google' })
  })

  it('requires an explicit model wherever the provider override came from, by origin', () => {
    // CLI provider with no CLI/profile model: the yml DeepSeek default must not leak in.
    expect(() => resolveLlmRoute({ cli: { provider: 'anthropic' }, profile: {}, ...SHIPPED }))
      .toThrow(/provider anthropic requires an explicit model/)
    // Profile provider paired with a profile model is explicit enough.
    expect(resolveLlmRoute({
      cli: {}, profile: { provider: 'openai', model: 'gpt-5' }, ...SHIPPED,
    })).toEqual({ provider: 'openai', dynamicPiAiProvider: undefined })
    // Profile provider with only the yml default model: same gap, same refusal.
    expect(() => resolveLlmRoute({ cli: {}, profile: { provider: 'openai' }, ...SHIPPED }))
      .toThrow(/provider openai requires an explicit model/)
  })

  it('trusts a yml-set non-DeepSeek provider only when its own row carries the model', () => {
    expect(resolveLlmRoute({
      cli: {}, profile: {},
      gateway: { provider: 'anthropic', model: 'claude-opus-4-8' },
      ymlPiAiProviders: ['openai', 'anthropic'],
    })).toEqual({ provider: 'anthropic', dynamicPiAiProvider: undefined })
    expect(() => resolveLlmRoute({
      cli: {}, profile: {},
      gateway: { provider: 'anthropic' },
      ymlPiAiProviders: ['openai', 'anthropic'],
    })).toThrow(/provider anthropic requires an explicit model/)
  })

  it('reuses the SHIPPED cordis.yml roster — the coupling that prevents the duplicate-adapter boot failure', () => {
    // Parsed from the real file through the production extraction, not a
    // literal roster: renaming the `llm-pi-ai` row or its providers field
    // must fail here, because composePatches reads exactly these shapes.
    const rows = parseIncludeYmlRows(join(import.meta.dirname, '..', 'cordis.yml'))
    const roster = ymlPiAiProvidersOf(rows)
    expect(roster).toEqual(['openai', 'anthropic'])
    const gateway = (rows.get('api-gateway')?.config ?? {}) as { provider?: unknown; model?: unknown }
    expect(resolveLlmRoute({
      cli: { provider: 'anthropic', model: 'claude-opus-4-8' }, profile: {},
      gateway, ymlPiAiProviders: roster,
    })).toEqual({ provider: 'anthropic', dynamicPiAiProvider: undefined })
  })

  it('fails loud on a missing or empty provider', () => {
    expect(() => resolveLlmRoute({ cli: {}, profile: {}, gateway: {}, ymlPiAiProviders: [] }))
      .toThrow(/provider must be a non-empty string/)
    expect(() => resolveLlmRoute({ cli: { provider: '' }, profile: {}, ...SHIPPED }))
      .toThrow(/provider must be a non-empty string/)
  })
})
