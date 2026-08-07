import { describe, expect, it } from 'vitest'
import { resolveProfiles } from '../src/config.ts'

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
