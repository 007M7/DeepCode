/**
 * Regression: the dsh-agent FIFO-conservation invariant must stay balanced on
 * the loop-authored continuation-reason steering path. A continue-with-reason
 * decision enters the steering FIFO and later drains (or is discarded by
 * cancel); both must be matched by an enqueue event so the invariant's
 * outstanding count never goes negative.
 * @module dsh-agent-loop/tests/inbox-invariant
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import InvariantService from '@deepseek-ai/dsh-invariants'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(InvariantService)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

describe('inbox FIFO-conservation invariant', () => {
  it('stays balanced when a continuation reason enters and drains the steering FIFO', async () => {
    const adapter = new MockAdapter([textResponse('step 1'), textResponse('step 2')])
    const ctx = await harness(adapter)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let forced = false
    ctx.on('agent/turn-continuation', async (_agent, _turn, _default, _signal, next) => {
      if (forced) return next()
      forced = true
      return { action: 'continue' as const, reason: { content: [{ type: 'text', text: 'keep going' }], source: { kind: 'plugin', plugin: 'loop' } } }
    })

    agent.followup([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)

    expect(adapter.requests).toHaveLength(2)
    // The continuation reason drained as a steering/message on the second step.
    expect(agent.session.events.some(e => e.type === 'steering/message')).toBe(true)
    // No invariant violation was logged.
    expect(warn.mock.calls.flat().some(arg => String(arg).includes('agent/inbox'))).toBe(false)
    expect(warn.mock.calls.flat().some(arg => String(arg).includes('INVARIANT'))).toBe(false)
  })

  it('stays balanced when cancel discards a pending continuation reason', async () => {
    const adapter = new MockAdapter([textResponse('only step')])
    const ctx = await harness(adapter)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    // Force a continuation reason, then cancel from the same checkpoint so the
    // reason sits in the steering FIFO when the inbox is discarded.
    ctx.on('agent/turn-continuation', async (subject, _turn, _default, _signal, next) => {
      if (subject !== agent) return next()
      queueMicrotask(() => { agent.cancel({ kind: 'user' }) })
      return { action: 'continue' as const, reason: { content: [{ type: 'text', text: 'keep going' }], source: { kind: 'plugin', plugin: 'loop' } } }
    })

    agent.followup([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)

    expect(warn.mock.calls.flat().some(arg => String(arg).includes('agent/inbox'))).toBe(false)
    expect(warn.mock.calls.flat().some(arg => String(arg).includes('INVARIANT'))).toBe(false)
  })

  it('stays balanced when a terminal stop discards pending steering', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harness(adapter)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    const discards: number[] = []
    ctx.on('agent/inbox/discard', (subject, messages) => { if (subject === agent) discards.push(messages.length) })

    // A continuation reason enqueues a steering item; a terminal stop then drops
    // it. The drop must emit a discard so the enqueue ⇒ dequeue-or-discard
    // ledger stays balanced (no dangling outstanding id).
    ctx.on('agent/turn-continuation', async (subject, _turn, _default, _signal, next) => {
      if (subject !== agent) return next()
      return { action: 'continue' as const, reason: { content: [{ type: 'text', text: 'keep going' }], source: { kind: 'plugin', plugin: 'loop' } } }
    })
    let stopped = false
    ctx.on('agent/turn-stop', (subject) => {
      if (subject !== agent || stopped) return undefined
      stopped = true
      return { action: 'stop' as const }
    })

    agent.followup([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)

    expect(discards).toEqual([1]) // the dropped steering item was reported
    expect(warn.mock.calls.flat().some(arg => String(arg).includes('agent/inbox'))).toBe(false)
    expect(warn.mock.calls.flat().some(arg => String(arg).includes('INVARIANT'))).toBe(false)
  })

  it('stays balanced when late steering lands after a terminal stop (post-turn flush window)', async () => {
    const adapter = new MockAdapter([textResponse('done')])
    const ctx = await harness(adapter)
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => undefined)
    const agent = ctx.agentLoop.create(SessionId('a1'), { provider: 'mock', model: 'mock' })

    let enqueues = 0
    const discards: number[] = []
    ctx.on('agent/inbox/enqueue', (subject) => { if (subject === agent) enqueues += 1 })
    ctx.on('agent/inbox/discard', (subject, messages) => { if (subject === agent) discards.push(messages.length) })

    // Terminal-stop the turn, then steer during the post-turn flush window
    // (status is still running). That late steer is drained by runLoop and
    // dropped because the turn terminally stopped; it must still be discarded so
    // its enqueue is matched (the drain sits on a different code path than the
    // in-turn terminal-stop drop).
    ctx.on('agent/turn-stop', subject => (subject === agent ? { action: 'stop' as const } : undefined))
    let steered = false
    ctx.on('session/flush', (session) => {
      if (session !== agent.session || steered) return
      steered = true
      agent.steer([{ type: 'text', text: 'late' }], { source: { kind: 'plugin', plugin: 'late' } })
    })

    agent.followup([{ type: 'text', text: 'go' }])
    await waitForIdle(ctx, agent)

    // The prompt plus the late steer both enqueued; both are matched (the prompt
    // dequeued, the late steer discarded) so no id is left outstanding.
    expect(enqueues).toBe(2)
    expect(discards).toEqual([1])
    expect(warn.mock.calls.flat().some(arg => String(arg).includes('agent/inbox'))).toBe(false)
    expect(warn.mock.calls.flat().some(arg => String(arg).includes('INVARIANT'))).toBe(false)
  })
})
