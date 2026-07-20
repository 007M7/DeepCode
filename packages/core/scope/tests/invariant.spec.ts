import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { scopeTarget } from '@deepseek-ai/dsh-scope'
import * as ScopeInvariant from '@deepseek-ai/dsh-scope/invariant'
import InvariantService from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantService)
  await ctx.plugin(ScopeInvariant)
  return ctx
}

function emit(ctx: Context, receiver: object | undefined, event: string, args: unknown[]): void {
  const dispatch = ctx.emit.bind(ctx) as (...values: unknown[]) => void
  if (receiver === undefined) dispatch(event, ...args)
  else dispatch(receiver, event, ...args)
}

describe('scoped-dispatch invariants', () => {
  it('ignores ordinary events and rejects a scoped dispatch without a carrier', async () => {
    const ctx = await setup()
    expect(() => { emit(ctx, undefined, 'ordinary/event', []) }).not.toThrow()
    const agent = { id: 'a1' }
    expect(() => { emit(ctx, undefined, 'agent/error', [agent, 1, 0, new Error('x')]) })
      .toThrow(/dispatched without a scope carrier/)
  })

  it('checks every generated subject resolver against the carrier key', async () => {
    const ctx = await setup()
    const agent = { id: 'a1' }
    const other = { id: 'a2' }
    const rows: Array<[string, unknown[]]> = [
      ['agent/created', [agent]],
      ['agent/disposed', [agent]],
      ['agent/error', [agent, 1, 0, new Error('x')]],
      ['agent/post-step', [agent, 1, 1]],
      ['agent/pre-step', [agent, 1, 1, new AbortController().signal]],
      ['agent/prompt-submit', [agent, [], { kind: 'user' }, () => Promise.resolve({ kind: 'allow' })]],
      ['agent/queued', [agent, [], { source: { kind: 'user' }, steering: false }]],
      ['agent/request', [agent, 1, 1, { model: 'm' }, () => Promise.resolve({ model: 'm' })]],
      ['agent/request-error', [agent, 1, 1, new Error('x')]],
      ['agent/session-prefix', [agent, [], new AbortController().signal, () => Promise.resolve([])]],
      ['agent/session-start', [agent, 'startup']],
      ['agent/status', [agent, 'idle']],
      ['agent/step-result', [agent, 1, 1, { role: 'assistant', content: [] }, () => Promise.resolve({ role: 'assistant', content: [] })]],
      ['agent/turn-continuation', [agent, 1, { action: 'stop' }, () => Promise.resolve({ action: 'stop' })]],
      ['agent/turn-stop', [agent, 1]],
      ['approval/request', [{ agent, toolName: 'echo' }, () => Promise.resolve('unavailable')]],
      ['goal/changed', [agent, { operation: 'create', ref: { id: 'goal-a', revision: 1 } }]],
      ['system-prompt/assemble', [[], { scope: agent }]],
      ['tools/execute', [{ callId: 'c', name: 't', arguments: {}, agent }, () => Promise.resolve({ content: [], isError: false })]],
      ['tools/post-execute', [{ callId: 'c', name: 't', arguments: {}, agent }, { content: [], isError: false }, () => Promise.resolve({ kind: 'accept' })]],
      ['tools/pre-execute', [{ callId: 'c', name: 't', arguments: {}, agent }, () => Promise.resolve({ kind: 'allow' })]],
      ['tools/result', [{ callId: 'c', name: 't', arguments: {}, agent }, { content: [], isError: false }]],
    ]

    for (const [event, args] of rows) {
      expect(() => { emit(ctx, scopeTarget(agent, agent), event, args) }, `${event} matching`).not.toThrow()
      expect(() => { emit(ctx, scopeTarget(agent, other), event, args) }, `${event} mismatched`)
        .toThrow(/DIFFERENT subject/)
    }
  })

  it('requires carriers for generated presence-only scoped events without comparing a payload subject', async () => {
    const ctx = await setup()
    const agent = { id: 'a1' }
    const rows: Array<[string, unknown[]]> = [
      ['session/created', [{}]],
      ['session/disposed', [{}]],
      ['session/event', [{}, {}]],
      ['session/flush', [{}]],
      ['subagent/end', [{}]],
      ['subagent/start', [{}]],
    ]
    for (const [event, args] of rows) {
      expect(() => { emit(ctx, scopeTarget(agent, agent), event, args) }, `${event} carrier`).not.toThrow()
      expect(() => { emit(ctx, undefined, event, args) }, `${event} no carrier`)
        .toThrow(/dispatched without a scope carrier/)
    }
  })
})
