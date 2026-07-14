import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { type Agent } from '@deepseek-ai/dsh-agent'

import SubagentService, { type SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import * as mock from '../src/index.ts'
import { SessionId } from '@deepseek-ai/dsh-session'

/** A minimal parent — the mock provider only reads `parent.id`. */
function fakeParent(id = 'parent-1'): Agent {
  return { id: SessionId(id) } as unknown as Agent
}

function baseRequest(over: Partial<SubagentStartRequest> = {}): SubagentStartRequest {
  return { prompt: [{ type: 'text', text: 'task' }], parent: fakeParent(), signal: new AbortController().signal, ...over }
}

async function mount(config: Partial<mock.Config> = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SubagentService)
  await ctx.plugin(mock, { name: 'mock', ...config })
  return ctx
}

describe('dsh-subagent-mock', () => {
  it('registers a provider on ctx.subagents and returns the scripted reply', async () => {
    const ctx = await mount({ reply: 'hello from mock' })
    expect(ctx.subagents.list()).toEqual(['mock'])

    const run = await ctx.subagents.start('mock', baseRequest())
    await expect(run.result).resolves.toEqual({
      output: [{ type: 'text', text: 'hello from mock' }],
      structured: undefined,
      stopReason: 'completed',
    })
    await run.dispose()
  })

  it('registers under a configurable name', async () => {
    const ctx = await mount({ name: 'spawn' })
    expect(ctx.subagents.list()).toEqual(['spawn'])
  })

  it('surfaces a structured result when the request carries an outputSchema', async () => {
    const ctx = await mount({ reply: 'r', structured: { answer: 42 } })
    const run = await ctx.subagents.start('mock', baseRequest({ outputSchema: { type: 'object', properties: { answer: { type: 'number' } } } }))
    await expect(run.result).resolves.toMatchObject({ structured: { answer: 42 } })
  })

  it('defaults structured output to { reply } when outputSchema is requested but no structured value is configured', async () => {
    const ctx = await mount({ reply: 'fallback reply' })
    const run = await ctx.subagents.start('mock', baseRequest({ outputSchema: { type: 'object', properties: { answer: { type: 'number' } } } }))
    await expect(run.result).resolves.toMatchObject({ structured: { reply: 'fallback reply' } })
  })

  it('omits structured output when outputSchema capability is off', async () => {
    const ctx = await mount({ capabilities: { outputSchema: false } })
    // The service rejects an outputSchema request against a no-cap provider, so
    // the structured path is only reachable when the cap is on; with it off and
    // no schema requested, the result has no structured field.
    const run = await ctx.subagents.start('mock', baseRequest())
    const result = await run.result
    expect(result).not.toHaveProperty('structured')
  })

  it('honors a configured stop reason', async () => {
    const ctx = await mount({ stopReason: 'refusal' })
    const run = await ctx.subagents.start('mock', baseRequest())
    await expect(run.result).resolves.toMatchObject({ stopReason: 'refusal' })
  })

  it('flips the stop reason to aborted when the signal fires before the result settles', async () => {
    const ctx = await mount()
    const controller = new AbortController()
    const run = await ctx.subagents.start('mock', baseRequest({ signal: controller.signal }))
    controller.abort()
    await expect(run.result).resolves.toMatchObject({ stopReason: 'aborted' })
  })

  it('rejects an already-aborted request before starting publication', async () => {
    const ctx = await mount()
    const controller = new AbortController()
    controller.abort()

    await expect(ctx.subagents.start('mock', baseRequest({ signal: controller.signal })))
      .rejects.toThrow('mock subagent start aborted before publication')
  })

  it('rejects when cancellation wins the asynchronous publication handoff', async () => {
    const ctx = await mount()
    const controller = new AbortController()
    const pending = ctx.subagents.start('mock', baseRequest({ signal: controller.signal }))

    controller.abort()

    await expect(pending).rejects.toThrow('mock subagent start aborted before publication')
  })

  it('unregisters the provider when the owning fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    const fiber = await ctx.plugin(mock, { name: 'mock' })
    expect(ctx.subagents.list()).toEqual(['mock'])
    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/Config/apply', () => {
    // A default export would make Loader unwrap only that value and drop `inject`.
    expect('default' in mock).toBe(false)
    expect(mock.name).toBe('subagent-mock')
    expect(mock.inject).toEqual(['subagents'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(mock) as Record<string, unknown>
    expect(unwrapped).toBe(mock)
    expect(unwrapped.name).toBe('subagent-mock')
    expect(unwrapped.inject).toEqual(['subagents'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
