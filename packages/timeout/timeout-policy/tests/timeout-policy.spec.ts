/**
 * Unit + real-load-path coverage for @deepseek-ai/dsh-timeout-policy. The
 * timeout-wins cases drive the deadline under fake timers (deterministic — no
 * wall-clock race) and use a COOPERATIVE tool that settles only when its
 * `exec.signal` aborts, mirroring how a real capability forwards the signal and
 * reaches quiescence.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import { CallId, HarnessError } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool, type ToolExecutionInput, type PostToolDecision } from '@deepseek-ai/dsh-tools'
import * as timeoutPolicy from '@deepseek-ai/dsh-timeout-policy'
import { TOOL_TIMEOUT } from '@deepseek-ai/dsh-timeout-policy'

/** Mount the registry + the zero-config timeout-policy enforcer. */
async function setup() {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(timeoutPolicy)
  return ctx
}

/** A cooperative tool that settles ONLY when its exec.signal aborts (returns text). */
const cooperativeTool = defineTool({
  name: 'slow', description: 'stops when aborted', parameters: {}, timeoutMs: 100,
  execute(_args, exec): Promise<{ type: 'text'; text: string }[]> {
    const done = [{ type: 'text' as const, text: 'stopped cooperatively' }]
    if (exec.signal?.aborted) return Promise.resolve(done)
    return new Promise((resolve) => { exec.signal?.addEventListener('abort', () => { resolve(done) }) })
  },
})

/** A cooperative tool that THROWS its own upstream-abort error when aborted (web-provider shape). */
const abortThrowingTool = defineTool({
  name: 'aborter', description: 'throws WEB_ABORTED when aborted', parameters: {}, timeoutMs: 100,
  execute(_args, exec): Promise<never> {
    if (exec.signal?.aborted) return Promise.reject(new HarnessError('web fetch aborted', 'WEB_ABORTED'))
    return new Promise((_resolve, reject) => { exec.signal?.addEventListener('abort', () => { reject(new HarnessError('web fetch aborted', 'WEB_ABORTED')) }) })
  },
})

describe('timeout-policy delegation (unconfigured / fast)', () => {
  it('delegates a tool with NO declared budget unchanged and does not touch exec.signal', async () => {
    const ctx = await setup()
    let seenSignal: AbortSignal | undefined
    ctx.tools.register(defineTool({ name: 'probe', description: 'd', parameters: {},
      async execute(_a, exec) { seenSignal = exec.signal; return [{ type: 'text' as const, text: 'ok' }] } }))
    const upstream = new AbortController().signal
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'probe', arguments: {}, signal: upstream })
    expect(result.isError).toBe(false)
    expect(seenSignal).toBe(upstream)
  })

  it('a tool with a budget that returns fast keeps its own result (no timeout)', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({ name: 'fast', description: 'd', parameters: {}, timeoutMs: 10_000,
      async execute() { return [{ type: 'text' as const, text: 'ok' }] } }))
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'fast', arguments: {} })
    expect(result).toEqual({ content: [{ type: 'text', text: 'ok' }], isError: false })
  })

  it('a budgeted tool receives the DERIVED deadline signal (not the caller signal) during dispatch', async () => {
    const ctx = await setup()
    let seenSignal: AbortSignal | undefined
    ctx.tools.register(defineTool({ name: 'probe', description: 'd', parameters: {}, timeoutMs: 10_000,
      async execute(_a, exec) { seenSignal = exec.signal; return [{ type: 'text' as const, text: 'ok' }] } }))
    const upstream = new AbortController().signal
    await ctx.tools.execute({ callId: CallId('c1'), name: 'probe', arguments: {}, signal: upstream })
    expect(seenSignal).toBeDefined()
    expect(seenSignal).not.toBe(upstream)
  })
})

describe('timeout-policy signal restoration', () => {
  it('restores the caller signal for post-execute after wrapping', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({ name: 'fast', description: 'd', parameters: {}, timeoutMs: 10_000,
      async execute() { return [{ type: 'text' as const, text: 'ok' }] } }))
    let postSignal: AbortSignal | undefined | 'unset' = 'unset'
    ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => { postSignal = exec.signal; return next() })
    const upstream = new AbortController().signal
    await ctx.tools.execute({ callId: CallId('c1'), name: 'fast', arguments: {}, signal: upstream })
    expect(postSignal).toBe(upstream)
  })

  it('deletes exec.signal again when the caller passed none', async () => {
    const ctx = await setup()
    ctx.tools.register(defineTool({ name: 'fast', description: 'd', parameters: {}, timeoutMs: 10_000,
      async execute() { return [{ type: 'text' as const, text: 'ok' }] } }))
    let hadSignal: boolean | undefined
    ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => { hadSignal = 'signal' in exec && exec.signal !== undefined; return next() })
    await ctx.tools.execute({ callId: CallId('c1'), name: 'fast', arguments: {} })
    expect(hadSignal).toBe(false)
  })
})

describe('timeout-policy TOOL_TIMEOUT replacement (deadline wins)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('replaces a cooperative tool result with TOOL_TIMEOUT when its own deadline fires', async () => {
    const ctx = await setup()
    ctx.tools.register(cooperativeTool)
    const pending = ctx.tools.execute({ callId: CallId('c1'), name: 'slow', arguments: {} })
    await vi.advanceTimersByTimeAsync(150)
    const result = await pending
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Error: tool call timed out after 100ms' }],
      isError: true,
      error: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' },
    })
  })

  it('replaces a provider-owned abort ERROR result with TOOL_TIMEOUT when the signal was ours', async () => {
    const ctx = await setup()
    ctx.tools.register(abortThrowingTool)
    const pending = ctx.tools.execute({ callId: CallId('c1'), name: 'aborter', arguments: {} })
    await vi.advanceTimersByTimeAsync(150)
    const result = await pending
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({ name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' })
    expect(result.content[0]).toMatchObject({ text: 'Error: tool call timed out after 100ms' })
  })

  it('does NOT replace when the caller aborts first (upstream cancel, not our timeout)', async () => {
    const ctx = await setup()
    ctx.tools.register(cooperativeTool)
    const upstream = new AbortController()
    const pending = ctx.tools.execute({ callId: CallId('c1'), name: 'slow', arguments: {}, signal: upstream.signal })
    upstream.abort('user cancelled')
    await vi.advanceTimersByTimeAsync(0)
    const result = await pending
    expect(result.isError).toBe(false)
    expect(result.content[0]).toMatchObject({ text: 'stopped cooperatively' })
  })
})

describe('timeout-policy contract', () => {
  it('exposes the owned code constant', () => {
    expect(TOOL_TIMEOUT).toBe('TOOL_TIMEOUT')
  })
})

describe('timeout-policy disposal (HMR safety)', () => {
  it('removes its tools/execute listener when the plugin fiber disposes', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    let seenSignal: AbortSignal | undefined
    ctx.tools.register(defineTool({ name: 'probe', description: 'd', parameters: {}, timeoutMs: 10_000,
      async execute(_a, exec) { seenSignal = exec.signal; return [{ type: 'text' as const, text: 'ok' }] } }))
    const fiber = await ctx.plugin(timeoutPolicy)
    const upstream = new AbortController().signal
    await ctx.tools.execute({ callId: CallId('c1'), name: 'probe', arguments: {}, signal: upstream })
    expect(seenSignal).not.toBe(upstream)
    await fiber.dispose()
    await ctx.tools.execute({ callId: CallId('c2'), name: 'probe', arguments: {}, signal: upstream })
    expect(seenSignal).toBe(upstream)
  })
})

describe('dsh-timeout-policy real-load-path guard', () => {
  it('has no default export and keeps name/inject through unwrapExports', () => {
    expect('default' in timeoutPolicy).toBe(false)
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(timeoutPolicy) as Record<string, unknown>
    expect(unwrapped).toBe(timeoutPolicy)
    expect(unwrapped.name).toBe('timeout-policy')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })

  it('boots over ctx.tools through the unwrapped module and wraps a budgeted tool', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    ctx.tools.register(defineTool({ name: 'fast', description: 'd', parameters: {}, timeoutMs: 5_000,
      async execute() { return [{ type: 'text' as const, text: 'ok' }] } }))
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(timeoutPolicy) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped)
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'fast', arguments: {} } satisfies ToolExecutionInput)
    expect(result.isError).toBe(false)
    await fiber.dispose()
  })
})
