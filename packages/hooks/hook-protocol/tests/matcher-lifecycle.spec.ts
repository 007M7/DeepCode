import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import type { RRegex as RustRegex } from 'rregex'

describe('compileMatchers — native regex lifecycle', () => {
  it('constructs each unique Codex regex once across repeated matches and frees it once', async () => {
    const require = createRequire(import.meta.url)
    const rregex = require('rregex') as { RRegex: new(pattern: string) => RustRegex }
    const OriginalRRegex = rregex.RRegex
    const construct = vi.fn<(pattern: string) => void>()
    const free = vi.fn<() => void>()

    class CountingRRegex extends OriginalRRegex {
      constructor(pattern: string) {
        super(pattern)
        construct(pattern)
      }

      override free(): void {
        free()
        super.free()
      }
    }

    rregex.RRegex = CountingRRegex
    vi.resetModules()
    try {
      const { compileMatchers } = await import('@deepseek-ai/dsh-hook-protocol/src/matcher.ts')
      const matchers = compileMatchers(['(?i)^bash$', '(?i)^bash$', '^write$'], 'codex')
      expect(construct.mock.calls.map(([pattern]) => pattern)).toEqual(['(?i)^bash$', '^write$'])

      for (let i = 0; i < 1_000; i++) {
        expect(matchers.matches('(?i)^bash$', 'BASH')).toBe(true)
      }
      expect(construct).toHaveBeenCalledTimes(2)

      matchers.dispose()
      matchers.dispose()
      expect(free).toHaveBeenCalledTimes(2)
    } finally {
      rregex.RRegex = OriginalRRegex
      vi.resetModules()
    }
  })
})
