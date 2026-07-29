import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import LocalSubprocessService from '@deepseek-ai/dsh-subprocess-local'

const matcherLifecycle = vi.hoisted(() => {
  const registry = {
    matches: vi.fn(() => true),
    diagnostic: vi.fn<(matcher: string | undefined) => string | undefined>(() => undefined),
    dispose: vi.fn<() => void>(),
  }
  return {
    registry,
    compileMatchers: vi.fn(() => registry),
  }
})

vi.mock('@deepseek-ai/dsh-hook-protocol', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-hook-protocol')>()
  return { ...actual, compileMatchers: matcherLifecycle.compileMatchers }
})

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  vi.clearAllMocks()
  matcherLifecycle.registry.diagnostic.mockReturnValue(undefined)
})

describe('hooks-codex matcher lifecycle', () => {
  it('disposes the compiled set when one event-specific diagnostic rejects the config', async () => {
    const { parseCodexConfig } = await import('@deepseek-ai/dsh-hooks-codex/src/config.ts')
    matcherLifecycle.registry.diagnostic.mockImplementation((matcher: string | undefined) => (
      matcher === '[' ? 'invalid codex regex matcher "["' : undefined
    ))

    expect(() => parseCodexConfig({
      PreToolUse: [
        { matcher: '(?i)^bash$', hooks: [{ type: 'command', command: 'first' }] },
        { matcher: '[', hooks: [{ type: 'command', command: 'second' }] },
      ],
    })).toThrow('invalid codex regex matcher "[" on event "PreToolUse"')

    expect(matcherLifecycle.compileMatchers).toHaveBeenCalledExactlyOnceWith(
      new Set(['(?i)^bash$', '[']),
      'codex',
    )
    expect(matcherLifecycle.registry.dispose).toHaveBeenCalledOnce()
  })

  it('gives the loaded config one matcher registry and disposes it on plugin teardown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-hooks-codex-matchers-'))
    dirs.push(dir)
    const configPath = join(dir, 'hooks.json')
    writeFileSync(configPath, JSON.stringify({ hooks: {
      PreToolUse: [{ matcher: '(?i)^bash$', hooks: [{ type: 'command', command: 'true' }] }],
      PostToolUse: [{ matcher: '(?i)^bash$', hooks: [{ type: 'command', command: 'true' }] }],
    } }))

    const HooksCodex = await import('@deepseek-ai/dsh-hooks-codex')
    const ctx = new Context()
    await ctx.plugin(LocalSubprocessService)
    await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
    const fiber = await ctx.plugin(HooksCodex, { configPath, model: 'm' })

    expect(matcherLifecycle.compileMatchers).toHaveBeenCalledExactlyOnceWith(new Set([
      '(?i)^bash$',
    ]), 'codex')
    expect(matcherLifecycle.registry.diagnostic).toHaveBeenCalledTimes(2)
    expect(matcherLifecycle.registry.dispose).not.toHaveBeenCalled()

    await fiber.dispose()
    expect(matcherLifecycle.registry.dispose).toHaveBeenCalledOnce()
  })
})
