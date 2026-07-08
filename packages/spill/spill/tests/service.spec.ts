/**
 * Tests for the spill seam INTERFACE: a minimal concrete subclass registers as
 * `ctx.spillFiles`, a second load throws (duplicate service), and disposal
 * releases the service. The storage behavior is the implementation's concern
 * (`@deepseek-ai/dsh-spill-local`); here we only pin the seam contract.
 */

import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { SpillFiles, SpillPath } from '@deepseek-ai/dsh-spill'
import type { SaveTextSpill, SpillRef } from '@deepseek-ai/dsh-spill'

/** Minimal concrete backend: records the last request, returns a fixed ref. */
class StubSpill extends SpillFiles {
  last: SaveTextSpill | undefined

  async saveText(input: SaveTextSpill): Promise<SpillRef> {
    this.last = input
    return { path: SpillPath(`/stub/${input.suggestedName}`), bytes: Buffer.byteLength(input.content, 'utf8') }
  }
}

function request(content: string): SaveTextSpill {
  return {
    owner: { sessionId: SessionId('s1') },
    source: { toolName: 'web_fetch', callId: CallId('c1'), label: 'result' },
    suggestedName: 'web_fetch.txt',
    content,
  }
}

describe('spill seam', () => {
  it('registers as ctx.spillFiles and saves text', async () => {
    const ctx = new Context()
    await ctx.plugin(StubSpill)
    const ref = await ctx.spillFiles.saveText(request('hello'))
    expect(ref).toEqual({ path: '/stub/web_fetch.txt', bytes: 5 })
    expect((ctx.spillFiles as StubSpill).last?.content).toBe('hello')
  })

  it('rejects a second implementation (one per context)', async () => {
    const ctx = new Context()
    await ctx.plugin(StubSpill)
    await expect(ctx.plugin(StubSpill)).rejects.toThrow()
  })

  it('releases the service on disposal', async () => {
    const ctx = new Context()
    const fiber = await ctx.plugin(StubSpill)
    expect(ctx.spillFiles).toBeInstanceOf(StubSpill)
    await fiber.dispose()
    expect((ctx as Context & { spillFiles?: unknown }).spillFiles).toBeUndefined()
  })
})
