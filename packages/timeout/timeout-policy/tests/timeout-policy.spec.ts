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
import ToolRegistry, { defineTool, type ToolExecution, type ToolExecutionResult, type PostToolDecision } from '@deepseek-ai/dsh-tools'
import * as timeoutPolicy from '@deepseek-ai/dsh-timeout-policy'
import { TOOL_TIMEOUT, toolTimeoutResult } from '@deepseek-ai/dsh-timeout-policy'

/** Mount the registry + the timeout-policy plugin with the given per-tool config. */
async function setup(tools: Record<string, { timeoutMs: number }> = {}) {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(timeoutPolicy, { tools })
  return ctx
}

/** A fast tool: returns immediately, ignoring the signal. */
const fastTool = defineTool({
  name: 'fast',
  description: 'returns at once',
  parameters: {},
  async execute() { return [{ type: 'text' as const, text: 'ok' }] },
})

/** A cooperative tool that settles ONLY when its exec.signal aborts (returns text). */
const cooperativeTool = defineTool({
  name: 'slow',
  description: 'stops when aborted',
  parameters: {},
  execute(_args, exec): Promise<{ type: 'text'; text: string }[]> {
    const done = [{ type: 'text' as const, text: 'stopped cooperatively' }]
    if (exec.signal?.aborted) return Promise.resolve(done)
    return new Promise((resolve) => {
      exec.signal?.addEventListener('abort', () => { resolve(done) })
    })
  },
})

/** A cooperative tool that THROWS its own upstream-abort error when aborted (web-provider shape). */
const abortThrowingTool = defineTool({
  name: 'aborter',
  description: 'throws WEB_ABORTED when aborted',
  parameters: {},
  execute(_args, exec): Promise<never> {
    if (exec.signal?.aborted) return Promise.reject(new HarnessError('web fetch aborted', 'WEB_ABORTED'))
    return new Promise((_resolve, reject) => {
      exec.signal?.addEventListener('abort', () => { reject(new HarnessError('web fetch aborted', 'WEB_ABORTED')) })
    })
  },
})

describe('timeout-policy config validation', () => {
  it('rejects a non-positive timeout at apply', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await expect(ctx.plugin(timeoutPolicy, { tools: { web_fetch: { timeoutMs: 0 } } }))
      .rejects.toThrow('tools.web_fetch.timeoutMs must be a positive finite number')
  })

  it('rejects a non-finite timeout at apply', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await expect(ctx.plugin(timeoutPolicy, { tools: { web_fetch: { timeoutMs: Infinity } } }))
      .rejects.toThrow('must be a positive finite number')
  })

  it('mounts with no config (empty tools default) and delegates every call', async () => {
    const ctx = await setup()
    ctx.tools.register(fastTool)
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'fast', arguments: {} })
    expect(result).toEqual({ callId: CallId('c1'), content: [{ type: 'text', text: 'ok' }], isError: false })
  })
})

describe('timeout-policy unknown-tool-name diagnostics', () => {
  it('warns for a configured tool name that is never registered (typo/stale key)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    // web_fech is a typo for web_fetch, and no tool by that name is registered.
    await ctx.plugin(timeoutPolicy, { tools: { web_fech: { timeoutMs: 30_000 } } })
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('"web_fech"')
    expect(warn.mock.calls[0]?.[0]).toContain('unregistered tool')
  })

  it('does NOT warn when the configured tool is already registered at load', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    ctx.tools.register(fastTool)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(timeoutPolicy, { tools: { fast: { timeoutMs: 30_000 } } })
    expect(warn).not.toHaveBeenCalled()
  })

  it('does NOT warn once a configured tool registers LATER (load-order safe)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    // Plugin loads before the tool it configures — the initial check would warn,
    // so register first is the interesting case: mount with a not-yet-present
    // name, then register it; the tools/change listener must clear it.
    await ctx.plugin(timeoutPolicy, { tools: { late: { timeoutMs: 30_000 } } })
    expect(warn).toHaveBeenCalledTimes(1) // absent at load → warned once
    warn.mockClear()
    ctx.tools.register({ ...fastTool, name: 'late' }) // now it registers
    // A subsequent tools/change must NOT re-warn the now-registered name.
    ctx.tools.register({ ...fastTool, name: 'other' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('warns at most once per unknown name across repeated tools/change', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    await ctx.plugin(timeoutPolicy, { tools: { ghost: { timeoutMs: 30_000 } } })
    expect(warn).toHaveBeenCalledTimes(1) // apply-time check
    // Each register/unregister emits tools/change; the ghost stays unknown but
    // must not be warned again.
    const dispose = ctx.tools.register(fastTool)
    dispose()
    ctx.tools.register({ ...fastTool, name: 'another' })
    expect(warn).toHaveBeenCalledTimes(1)
  })
})

describe('timeout-policy delegation (unconfigured / fast)', () => {
  it('delegates an UNCONFIGURED tool unchanged and does not touch exec.signal', async () => {
    const ctx = await setup({ other: { timeoutMs: 50 } })
    let seenSignal: AbortSignal | undefined
    ctx.tools.register({ ...fastTool, name: 'probe', async execute(_a, exec) { seenSignal = exec.signal; return [{ type: 'text' as const, text: 'ok' }] } })

    const upstream = new AbortController().signal
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'probe', arguments: {}, signal: upstream })
    expect(result.isError).toBe(false)
    expect(seenSignal).toBe(upstream) // no deadline derived for an unconfigured tool
  })

  it('a configured tool that returns fast keeps its own result (no timeout)', async () => {
    const ctx = await setup({ fast: { timeoutMs: 10_000 } })
    ctx.tools.register(fastTool)
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'fast', arguments: {} })
    expect(result).toEqual({ callId: CallId('c1'), content: [{ type: 'text', text: 'ok' }], isError: false })
  })

  it('a configured tool receives the DERIVED deadline signal (not the caller signal) during dispatch', async () => {
    const ctx = await setup({ probe: { timeoutMs: 10_000 } })
    let seenSignal: AbortSignal | undefined
    ctx.tools.register({ ...fastTool, name: 'probe', async execute(_a, exec) { seenSignal = exec.signal; return [{ type: 'text' as const, text: 'ok' }] } })

    const upstream = new AbortController().signal
    await ctx.tools.execute({ callId: CallId('c1'), name: 'probe', arguments: {}, signal: upstream })
    expect(seenSignal).toBeDefined()
    expect(seenSignal).not.toBe(upstream) // the plugin swapped in its fused deadline signal
  })
})

describe('timeout-policy signal restoration', () => {
  it('restores the caller signal for post-execute after wrapping', async () => {
    const ctx = await setup({ fast: { timeoutMs: 10_000 } })
    ctx.tools.register(fastTool)
    let postSignal: AbortSignal | undefined | 'unset' = 'unset'
    ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
      postSignal = exec.signal
      return next()
    })

    const upstream = new AbortController().signal
    await ctx.tools.execute({ callId: CallId('c1'), name: 'fast', arguments: {}, signal: upstream })
    expect(postSignal).toBe(upstream) // restored to the caller's own signal, not the deadline
  })

  it('deletes exec.signal again when the caller passed none', async () => {
    const ctx = await setup({ fast: { timeoutMs: 10_000 } })
    ctx.tools.register(fastTool)
    let hadSignal: boolean | undefined
    ctx.on('tools/post-execute', async (exec, _result, next): Promise<PostToolDecision> => {
      hadSignal = 'signal' in exec && exec.signal !== undefined
      return next()
    })

    await ctx.tools.execute({ callId: CallId('c1'), name: 'fast', arguments: {} })
    expect(hadSignal).toBe(false) // no caller signal → exec.signal absent again after wrapping
  })
})

describe('timeout-policy TOOL_TIMEOUT replacement (deadline wins)', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('replaces a cooperative tool result with TOOL_TIMEOUT when its own deadline fires', async () => {
    const ctx = await setup({ slow: { timeoutMs: 100 } })
    ctx.tools.register(cooperativeTool)

    const pending = ctx.tools.execute({ callId: CallId('c1'), name: 'slow', arguments: {} })
    await vi.advanceTimersByTimeAsync(150) // past the 100ms deadline: the timer fires, the tool settles
    const result = await pending

    expect(result).toEqual({
      callId: CallId('c1'),
      content: [{ type: 'text', text: 'Error: tool call timed out after 100ms' }],
      isError: true,
      error: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' },
    })
  })

  it('replaces a provider-owned abort ERROR result with TOOL_TIMEOUT (not WEB_ABORTED) when the signal was ours', async () => {
    const ctx = await setup({ aborter: { timeoutMs: 100 } })
    ctx.tools.register(abortThrowingTool)

    const pending = ctx.tools.execute({ callId: CallId('c1'), name: 'aborter', arguments: {} })
    await vi.advanceTimersByTimeAsync(150)
    const result = await pending

    // Dispatch first normalized the thrown WEB_ABORTED into an isError result;
    // the plugin then replaced THAT with TOOL_TIMEOUT because its own timer won.
    expect(result.isError).toBe(true)
    expect(result.error).toEqual({ name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' })
    expect(result.content[0]).toMatchObject({ text: 'Error: tool call timed out after 100ms' })
  })

  it('does NOT replace when the caller aborts first (upstream cancel, not our timeout)', async () => {
    const ctx = await setup({ slow: { timeoutMs: 100 } })
    ctx.tools.register(cooperativeTool)

    const upstream = new AbortController()
    const pending = ctx.tools.execute({ callId: CallId('c1'), name: 'slow', arguments: {}, signal: upstream.signal })
    upstream.abort('user cancelled') // fires before the 100ms timer
    await vi.advanceTimersByTimeAsync(0)
    const result = await pending

    // Our timer never fired, so timeoutOf(code) is undefined: the tool's own
    // cooperative result stands, not a TOOL_TIMEOUT.
    expect(result.isError).toBe(false)
    expect(result.content[0]).toMatchObject({ text: 'stopped cooperatively' })
  })
})

describe('toolTimeoutResult', () => {
  it('builds the structured TOOL_TIMEOUT result', () => {
    expect(toolTimeoutResult(CallId('c9'), 250)).toEqual({
      callId: CallId('c9'),
      content: [{ type: 'text', text: 'Error: tool call timed out after 250ms' }],
      isError: true,
      error: { name: 'ToolTimeoutError', code: 'TOOL_TIMEOUT' },
    } satisfies ToolExecutionResult)
  })

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
    ctx.tools.register({ ...fastTool, name: 'probe', async execute(_a, exec) { seenSignal = exec.signal; return [{ type: 'text' as const, text: 'ok' }] } })

    // Mount the policy on its OWN fiber so disposing it removes only the wrapper.
    const fiber = await ctx.plugin(timeoutPolicy, { tools: { probe: { timeoutMs: 10_000 } } })
    const upstream = new AbortController().signal
    await ctx.tools.execute({ callId: CallId('c1'), name: 'probe', arguments: {}, signal: upstream })
    expect(seenSignal).not.toBe(upstream) // wrapper live: dispatch saw the derived deadline signal

    await fiber.dispose()
    // Listener gone: the tool now receives the caller's own signal unwrapped. A
    // leaked stale wrapper would still derive a deadline and fail this.
    await ctx.tools.execute({ callId: CallId('c2'), name: 'probe', arguments: {}, signal: upstream })
    expect(seenSignal).toBe(upstream)
  })
})

describe('dsh-timeout-policy real-load-path guard', () => {
  it('has no default export and keeps name/inject/Config through unwrapExports', () => {
    expect('default' in timeoutPolicy).toBe(false)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(timeoutPolicy) as Record<string, unknown>
    expect(unwrapped).toBe(timeoutPolicy)
    expect(unwrapped.name).toBe('timeout-policy')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(typeof unwrapped.apply).toBe('function')
    expect(unwrapped.Config).toBeDefined()
  })

  it('boots over ctx.tools through the unwrapped module and wraps a configured tool', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    ctx.tools.register(fastTool)

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(timeoutPolicy) as Parameters<Context['plugin']>[0]
    const fiber = await ctx.plugin(unwrapped, { tools: { fast: { timeoutMs: 5_000 } } })
    // A configured fast tool still succeeds (deadline never fires); this proves
    // the wrapper is live through the real Loader path.
    const result = await ctx.tools.execute({ callId: CallId('c1'), name: 'fast', arguments: {} } satisfies ToolExecution)
    expect(result.isError).toBe(false)
    await fiber.dispose()
  })
})
