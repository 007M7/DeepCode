import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import type { RRegex as RustRegex } from 'rregex'

const POOL_KEY = Symbol.for('@deepseek-ai/dsh-hook-protocol/rregex-pool/v1')

interface PoolEntry {
  regex?: RustRegex
}

type RRegexModule = {
  RRegex: new(pattern: string) => RustRegex
  __wbindgen_memory(): WebAssembly.Memory
} & Record<symbol, unknown>

function restorePool(rregex: RRegexModule, original: unknown): void {
  Reflect.deleteProperty(rregex, POOL_KEY)
  if (original !== undefined) rregex[POOL_KEY] = original
}

describe('Codex regex intern lifecycle', () => {
  it('keeps 100,000 same-pattern reloads bounded and reuses across module reload', async () => {
    const require = createRequire(import.meta.url)
    const rregex = require('rregex') as RRegexModule
    const OriginalRRegex = rregex.RRegex
    const originalPool = rregex[POOL_KEY]
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

    Reflect.deleteProperty(rregex, POOL_KEY)
    rregex.RRegex = CountingRRegex
    vi.resetModules()
    const before = rregex.__wbindgen_memory().buffer.byteLength
    try {
      const first = await import('@deepseek-ai/dsh-hook-protocol/src/matcher.ts')
      for (let i = 0; i < 100_000; i++) {
        first.compileMatchers(['(?i)^bash$'], 'codex').dispose()
      }
      expect(construct).toHaveBeenCalledExactlyOnceWith('(?i)^bash$')
      expect(free).not.toHaveBeenCalled()
      expect(rregex.__wbindgen_memory().buffer.byteLength - before).toBeLessThanOrEqual(4 * 1024 * 1024)

      vi.resetModules()
      const reloaded = await import('@deepseek-ai/dsh-hook-protocol/src/matcher.ts')
      expect(reloaded.matcherDiagnostic('(?i)^bash$', 'codex')).toBeUndefined()
      expect(reloaded.matchesMatcher('(?i)^bash$', 'BASH', 'codex')).toBe(true)
      expect(construct).toHaveBeenCalledTimes(1)
      expect(free).not.toHaveBeenCalled()
    } finally {
      const temporaryPool = rregex[POOL_KEY]
      if (temporaryPool instanceof Map) {
        for (const entry of temporaryPool.values() as Iterable<PoolEntry>) entry.regex?.free()
      }
      rregex.RRegex = OriginalRRegex
      restorePool(rregex, originalPool)
      vi.resetModules()
    }
  })

  it('memoizes failures and rejects a new pattern before construction at the hard cap', async () => {
    const require = createRequire(import.meta.url)
    const rregex = require('rregex') as RRegexModule
    const OriginalRRegex = rregex.RRegex
    const originalPool = rregex[POOL_KEY]
    const construct = vi.fn<(pattern: string) => void>()

    class FakeRRegex {
      constructor(pattern: string) {
        construct(pattern)
        if (pattern === 'invalid(') throw new SyntaxError('invalid test pattern')
      }

      isMatch(): boolean {
        return true
      }
    }

    Reflect.deleteProperty(rregex, POOL_KEY)
    rregex.RRegex = FakeRRegex as unknown as typeof rregex.RRegex
    vi.resetModules()
    try {
      const matcher = await import('@deepseek-ai/dsh-hook-protocol/src/matcher.ts')
      expect(matcher.matcherDiagnostic('invalid(', 'codex')).toBe('invalid codex regex matcher "invalid("')
      expect(matcher.matcherDiagnostic('invalid(', 'codex')).toBe('invalid codex regex matcher "invalid("')
      expect(construct).toHaveBeenCalledTimes(1)

      for (let i = 0; i < matcher.MAX_INTERNED_CODEX_REGEX_PATTERNS - 1; i++) {
        expect(matcher.matcherDiagnostic(`^value-${i}$`, 'codex')).toBeUndefined()
      }
      expect(construct).toHaveBeenCalledTimes(matcher.MAX_INTERNED_CODEX_REGEX_PATTERNS)

      expect(matcher.matcherDiagnostic('^overflow$', 'codex')).toBe(
        `codex regex matcher capacity exceeded (${matcher.MAX_INTERNED_CODEX_REGEX_PATTERNS} distinct patterns per process) for "^overflow$"`,
      )
      expect(matcher.matchesMatcher('^overflow$', 'overflow', 'codex')).toBe(false)
      expect(construct).toHaveBeenCalledTimes(matcher.MAX_INTERNED_CODEX_REGEX_PATTERNS)

      vi.resetModules()
      const reloaded = await import('@deepseek-ai/dsh-hook-protocol/src/matcher.ts')
      expect(reloaded.matchesMatcher('^value-0$', 'anything', 'codex')).toBe(true)
      expect(reloaded.matcherDiagnostic('invalid(', 'codex')).toBe('invalid codex regex matcher "invalid("')
      expect(construct).toHaveBeenCalledTimes(matcher.MAX_INTERNED_CODEX_REGEX_PATTERNS)
    } finally {
      rregex.RRegex = OriginalRRegex
      restorePool(rregex, originalPool)
      vi.resetModules()
    }
  })
})
