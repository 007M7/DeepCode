import { createRequire } from 'node:module'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessService from '@deepseek-ai/dsh-subprocess-local'

interface RustRegexInstance {
  free(): void
}

const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

describe('hooks-codex matcher lifecycle', () => {
  it('constructs one reusable runtime regex and frees it on plugin teardown', async () => {
    // The product deliberately loads rregex through createRequire so Cordis can
    // discover the bridge synchronously. Patch that SAME CJS export, rather
    // than an ESM mock that would not observe the production load path.
    const require = createRequire(new URL('../../hook-protocol/package.json', import.meta.url))
    const rregex = require('rregex') as { RRegex: new(pattern: string) => RustRegexInstance }
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

    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-codex-matchers-'))
    dirs.push(dir)
    const configPath = join(dir, 'hooks.json')
    writeFileSync(configPath, JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: '(?i)^bash$', hooks: [{ type: 'command', command: 'true' }] }],
      PostToolUse: [{ matcher: '(?i)^bash$', hooks: [{ type: 'command', command: 'true' }] }],
    } }))

    rregex.RRegex = CountingRRegex
    vi.resetModules()
    try {
      const HooksCodex = await import('@deepseek-ai/dsh-hooks-codex')
      const ctx = new Context()
      await ctx.plugin(LocalSubprocessService)
      await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
      const fiber = await ctx.plugin(HooksCodex, { configPath, model: 'm' })

      // The parser validates both groups one-shot (2 construct/free pairs), then
      // the runtime registry compiles the duplicate pattern only once and owns it.
      expect(construct.mock.calls.map(([pattern]) => pattern)).toEqual([
        '(?i)^bash$',
        '(?i)^bash$',
        '(?i)^bash$',
      ])
      expect(free).toHaveBeenCalledTimes(2)

      await fiber.dispose()
      expect(free).toHaveBeenCalledTimes(3)
    } finally {
      rregex.RRegex = OriginalRRegex
      vi.resetModules()
    }
  })
})
