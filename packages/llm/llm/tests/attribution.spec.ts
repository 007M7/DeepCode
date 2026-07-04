import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'
import { APP_IDENTITY, attributionHeaders, userAgent } from '@deepseek-ai/dsh-llm'
import type { AppIdentity, AttributionTarget } from '@deepseek-ai/dsh-llm'

const manifest = createRequire(import.meta.url)('../package.json') as { version: string }

/** A white-label identity exercising every override seam. */
const forkIdentity: AppIdentity = {
  product: 'fork-agent',
  version: '9.9.9',
  title: 'Fork Agent',
  url: 'https://example.com/fork-agent',
  categories: ['ide-extension', 'cli-agent'],
}

describe('APP_IDENTITY', () => {
  it('sources the version from the package manifest, never a hand-copied constant', () => {
    expect(APP_IDENTITY.version).toBe(manifest.version)
  })

  it('carries only static public product facts', () => {
    expect(APP_IDENTITY).toEqual({
      product: 'deepseek-harness',
      version: manifest.version,
      title: 'DeepSeek Harness',
      url: 'https://github.com/deepseek-ai/deepseek-harness-sdk',
      categories: ['cli-agent'],
    })
  })
})

describe('userAgent', () => {
  it('renders product/version with the +url comment', () => {
    expect(userAgent()).toBe(
      `deepseek-harness/${manifest.version} (+https://github.com/deepseek-ai/deepseek-harness-sdk)`,
    )
  })

  it('renders a custom identity', () => {
    expect(userAgent(forkIdentity)).toBe('fork-agent/9.9.9 (+https://example.com/fork-agent)')
  })
})

describe('attributionHeaders', () => {
  it('defaults to the provider-neutral baseline: User-Agent and nothing else', () => {
    expect(attributionHeaders()).toEqual({ 'user-agent': userAgent() })
  })

  it('adds exactly the OpenRouter set for the openrouter target', () => {
    expect(attributionHeaders('openrouter')).toEqual({
      'user-agent': userAgent(),
      'http-referer': APP_IDENTITY.url,
      'x-openrouter-title': APP_IDENTITY.title,
      'x-openrouter-categories': 'cli-agent',
    })
  })

  it('maps a custom identity onto both targets', () => {
    expect(attributionHeaders('generic', forkIdentity)).toEqual({
      'user-agent': 'fork-agent/9.9.9 (+https://example.com/fork-agent)',
    })
    expect(attributionHeaders('openrouter', forkIdentity)).toEqual({
      'user-agent': 'fork-agent/9.9.9 (+https://example.com/fork-agent)',
      'http-referer': 'https://example.com/fork-agent',
      'x-openrouter-title': 'Fork Agent',
      'x-openrouter-categories': 'ide-extension,cli-agent',
    })
  })

  it('rejects targets outside the closed union at runtime', () => {
    expect(() => attributionHeaders('acme' as unknown as AttributionTarget))
      .toThrow('unreachable variant in attributionHeaders: "acme"')
  })
})
