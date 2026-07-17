/**
 * Tests for the spill-policy PLUGIN. It registers no service, only the
 * `tools/post-execute` transformer. We drive real tools through
 * `ctx.tools.execute(...)` and assert: disabled mode is a true no-op, an
 * oversized plain-text result is spilled and replaced with a preview + locator,
 * a small result and a non-text result pass through, `read` is skipped, and a
 * `saveText` failure / missing backend / missing owner all preserve the original
 * result without an `isError`.
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { SpillLocator, SpillStore } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'
import * as SpillPolicy from '@deepseek-ai/dsh-spill-policy'

/** A stub spill backend recording its saves; `fail` exercises the best-effort fallback. */
class StubStore extends SpillStore {
  saves: SaveTextSpill[] = []
  fail = false

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    if (this.fail) throw new Error('disk full')
    this.saves.push(input)
    return {
      locator: SpillLocator(`/spill/${input.suggestedName}`),
      bytes: Buffer.byteLength(input.content, 'utf8'),
      retrievalHint: 'Use the stub retrieval path.',
    }
  }
}

/** A tool returning `text` verbatim (name configurable so we can register `read`). */
function textTool(name: string, text: string) {
  return defineTool({
    name,
    description: name,
    parameters: {},
    async execute(): Promise<ContentBlock[]> { return [{ type: 'text', text }] },
  })
}

/** A minimal exec carrying a session header id (the spill owner). */
function exec(name: string, session = 's1'): ToolExecution {
  // Only agent.session.header.id is read by the policy; a structural stub suffices.
  const agent = { session: { header: { id: SessionId(session) } } }
  return { callId: CallId(`call-${name}`), name, arguments: {}, agent } as unknown as ToolExecution
}

/**
 * Build a context with tools + the policy, and optionally a spill backend.
 * Returns the context and the backend handle (undefined when `withSpill` false).
 */
async function setup(config: SpillPolicy.Config, withSpill = true): Promise<{ ctx: Context; spill?: StubStore; fiber: Awaited<ReturnType<Context['plugin']>> }> {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  let spill: StubStore | undefined
  if (withSpill) {
    await ctx.plugin(StubStore)
    spill = ctx.spillStore as StubStore
  }
  const fiber = await ctx.plugin(SpillPolicy, config)
  return { ctx, fiber, ...spill ? { spill } : {} }
}

/** Flatten a result's text blocks. */
function textOf(content: ContentBlock[]): string {
  return content.filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text').map(b => b.text).join('')
}

describe('disabled mode', () => {
  it('registers no post-execute listener when maxInlineBytes is omitted', async () => {
    const { ctx, spill } = await setup({})
    ctx.tools.register(textTool('big', 'x'.repeat(1000)))
    const result = await ctx.tools.execute(exec('big'))
    expect(textOf(result.content)).toBe('x'.repeat(1000))
    expect(result.isError).toBe(false)
    expect(spill?.saves).toHaveLength(0)
  })
})

describe('loader export shape', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in SpillPolicy).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(SpillPolicy) as Record<string, unknown>
    expect(unwrapped).toBe(SpillPolicy)
    expect(unwrapped.name).toBe('spill-policy')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(unwrapped.Config).toBeDefined()
    expect(typeof unwrapped.apply).toBe('function')
  })
})

describe('config validation', () => {
  it('rejects a negative maxInlineBytes at load', async () => {
    await expect(setup({ maxInlineBytes: -1 })).rejects.toThrow(/non-negative integer/)
  })

  it('rejects a fractional maxInlineBytes at load', async () => {
    await expect(setup({ maxInlineBytes: 1.5 })).rejects.toThrow(/non-negative integer/)
  })
})

describe('oversized plain-text replacement', () => {
  it('spills the full text and replaces the result with a preview + locator within the cap', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 200 })
    const body = 'HEAD'.repeat(200) + 'TAIL'.repeat(200) // 1600 bytes > 200
    ctx.tools.register(textTool('big', body))
    const result = await ctx.tools.execute(exec('big'))

    expect(result.isError).toBe(false)
    expect(spill?.saves).toHaveLength(1)
    expect(spill?.saves[0]?.content).toBe(body)
    expect(spill?.saves[0]?.source.toolName).toBe('big')
    expect(spill?.saves[0]?.suggestedName).toBe('big.txt')
    expect(spill?.saves[0]?.owner.sessionId).toBe('s1')

    const text = textOf(result.content)
    expect(text).not.toBe(body)
    expect(text.startsWith('HEAD')).toBe(true)
    expect(text).toContain('Full formatted result stored at: /spill/big.txt')
    expect(text).toContain('Use the stub retrieval path.')
    expect(text).toContain('Omitted')
    // The replacement (preview + blank line + notice) stays within the cap and
    // is smaller than the original — the whole point of spilling.
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(200)
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThan(body.length)
  })

  it('keeps the inline result when the notice-only replacement would exceed the cap', async () => {
    // A body just over a tiny cap: the notice alone is larger than the cap, so
    // there is no within-cap replacement — the policy keeps the inline result.
    const { ctx } = await setup({ maxInlineBytes: 4 })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const body = 'xxxxx' // 5 bytes > 4, but far shorter than the notice
    ctx.tools.register(textTool('big', body))
    const result = await ctx.tools.execute(exec('big'))
    expect(textOf(result.content)).toBe(body)
    expect(warn).toHaveBeenCalled()
  })

  it('leaves a small plain-text result unchanged', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 1000 })
    ctx.tools.register(textTool('small', 'tiny'))
    const result = await ctx.tools.execute(exec('small'))
    expect(textOf(result.content)).toBe('tiny')
    expect(spill?.saves).toHaveLength(0)
  })

  it('leaves a result with a non-text block unchanged', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 5 })
    ctx.tools.register(defineTool({
      name: 'mixed',
      description: 'mixed',
      parameters: {},
      async execute(): Promise<ContentBlock[]> {
        return [{ type: 'text', text: 'x'.repeat(100) }, { type: 'reasoning', text: 'why' }]
      },
    }))
    const result = await ctx.tools.execute(exec('mixed'))
    expect(spill?.saves).toHaveLength(0)
    expect(result.content).toHaveLength(2)
  })
})

describe('read skip', () => {
  it('never spills the read tool result (avoids a read → spill → read loop)', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 10 })
    ctx.tools.register(textTool('read', 'x'.repeat(1000)))
    const result = await ctx.tools.execute(exec('read'))
    expect(textOf(result.content)).toBe('x'.repeat(1000))
    expect(spill?.saves).toHaveLength(0)
  })
})

describe('best-effort fallback', () => {
  it('keeps the original result when saveText fails', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 10 })
    spill!.fail = true
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.tools.register(textTool('big', 'x'.repeat(1000)))
    const result = await ctx.tools.execute(exec('big'))
    expect(textOf(result.content)).toBe('x'.repeat(1000))
    expect(result.isError).toBe(false)
    expect(warn).toHaveBeenCalled()
  })

  it('keeps the original result when no spill backend is loaded', async () => {
    const { ctx } = await setup({ maxInlineBytes: 10 }, false)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.tools.register(textTool('big', 'x'.repeat(1000)))
    const result = await ctx.tools.execute(exec('big'))
    expect(textOf(result.content)).toBe('x'.repeat(1000))
    expect(warn).toHaveBeenCalled()
  })

  it('keeps the original result when the call has no session owner', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 10 })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    ctx.tools.register(textTool('big', 'x'.repeat(1000)))
    const result = await ctx.tools.execute({ callId: CallId('c'), name: 'big', arguments: {} })
    expect(textOf(result.content)).toBe('x'.repeat(1000))
    expect(spill?.saves).toHaveLength(0)
    expect(warn).toHaveBeenCalled()
  })
})

describe('composition', () => {
  it('bounds content a downstream post-execute listener replaced', async () => {
    const { ctx, spill } = await setup({ maxInlineBytes: 200 })
    // A later-registered listener replaces the (small) tool result with a big one;
    // the policy delegated via next(), so it bounds the replacement.
    ctx.on('tools/post-execute', async (_e, _r, _next) =>
      ({ kind: 'accept', content: [{ type: 'text', text: 'z'.repeat(500) }] }))
    ctx.tools.register(textTool('small', 'tiny'))
    const result = await ctx.tools.execute(exec('small'))
    expect(spill?.saves[0]?.content).toBe('z'.repeat(500))
    expect(textOf(result.content)).toContain('Full formatted result stored at')
  })

  it('preserves downstream accept-decision contexts when spilling', async () => {
    const { ctx } = await setup({ maxInlineBytes: 200 })
    const context = { content: [{ type: 'text' as const, text: 'note' }], source: { kind: 'plugin' as const, plugin: 'test' } }
    ctx.on('tools/post-execute', async (_e, _r, _next) =>
      ({ kind: 'accept', additionalContexts: [context] }))
    ctx.tools.register(textTool('big', 'x'.repeat(1000)))
    const result = await ctx.tools.execute(exec('big'))
    expect(textOf(result.content)).toContain('Full formatted result stored at')
    expect(result.additionalContexts).toEqual([context])
  })
})

describe('cap invariant', () => {
  it('keeps the inline result when the notice alone exceeds the cap, even for a large original', async () => {
    // A large body (so it is well over the cap) but a cap smaller than the
    // notice itself: there is no within-cap replacement, so the policy must keep
    // the inline result rather than emit content over maxInlineBytes.
    const { ctx } = await setup({ maxInlineBytes: 8 })
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const body = 'x'.repeat(5000)
    ctx.tools.register(textTool('big', body))
    const result = await ctx.tools.execute(exec('big'))
    expect(textOf(result.content)).toBe(body)
    expect(warn).toHaveBeenCalled()
  })
})

describe('disposal (HMR safety)', () => {
  it('stops transforming oversized results after the plugin fiber is disposed', async () => {
    const { ctx, spill, fiber } = await setup({ maxInlineBytes: 200 })
    const body = 'HEAD'.repeat(200) + 'TAIL'.repeat(200)
    ctx.tools.register(textTool('big', body))

    // Live: the listener spills and replaces.
    const before = await ctx.tools.execute(exec('big'))
    expect(textOf(before.content)).toContain('Full formatted result stored at')
    expect(spill?.saves).toHaveLength(1)

    // After disposal the listener is gone — the result passes through untouched
    // and nothing more is spilled (no leaked registration across reload).
    await fiber.dispose()
    const after = await ctx.tools.execute(exec('big'))
    expect(textOf(after.content)).toBe(body)
    expect(spill?.saves).toHaveLength(1)
  })
})
