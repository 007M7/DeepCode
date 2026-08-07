import { describe, expect, it } from 'vitest'
import { Config, resolveProfiles } from '../src/config.ts'

describe('API key format', () => {
  it('trims a padded literal apiKey into the resolved profile', () => {
    const resolved = resolveProfiles({ openai: { apiKey: '  sk-abc  ', baseURL: 'https://acme.test' } })
    expect(resolved.get('openai')?.apiKey).toBe('sk-abc')
  })

  it('keeps an omitted apiKey absent so ambient authentication still applies', () => {
    const resolved = resolveProfiles({ openai: { baseURL: 'https://acme.test' } })
    expect(resolved.get('openai')?.apiKey).toBeUndefined()
  })

  it('still tells an empty apiKey to omit itself', () => {
    expect(() => resolveProfiles({ openai: { apiKey: '   ', baseURL: 'https://acme.test' } }))
      .toThrow(/omit it to use ambient authentication/)
  })

  it('rejects an apiKey no header can carry', () => {
    expect(() => resolveProfiles({ openai: { apiKey: 'sk-\u{1F600}', baseURL: 'https://acme.test' } }))
      .toThrow(/no HTTP header can carry/)
  })
})

describe('reasoning schema boundary', () => {
  const configWith = (model: Record<string, unknown>): (() => unknown) =>
    () => Config({
      providers: {
        'acme-gateway': {
          api: 'openai-completions',
          baseURL: 'https://acme.test',
          models: [{ id: 'm', ...model }],
        },
      },
    })

  it('rejects a level pi-ai does not know at the write that produced it', () => {
    expect(configWith({ reasoningEfforts: { ultra: 'x' } })).toThrow(/"off"/)
    expect(configWith({ reasoningEfforts: { high: 42 } })).toThrow()
  })

  it('keeps false distinguishable from an absent declaration', () => {
    type Materialized = { providers: Record<string, { models?: { reasoningEfforts?: unknown }[] }> }
    const withFalse = configWith({ reasoningEfforts: false })() as Materialized
    expect(withFalse.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBe(false)
    const absent = configWith({})() as Materialized
    expect(absent.providers['acme-gateway']?.models?.[0]?.reasoningEfforts).toBeUndefined()
  })

  it('rejects a thinking format outside the offered set', () => {
    expect(configWith({ compat: { thinkingFormat: 'quantum' } })).toThrow(/expected/)
  })
})
