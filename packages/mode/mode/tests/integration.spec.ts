import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry, { defineTool } from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import AgentLoop, { ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import ModesService, { PLAN_MODE, foldMode } from '@deepseek-ai/dsh-mode'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Full-loop integration: a scripted mock model drives the REAL mode plugin
 * through the agent loop — the pending-intent flush at the turn boundary, the
 * assembly the soft layer filters, the `request/header`/`request/header-delta`
 * trail every transition leaves, and the hard gate's deny. Only the model is
 * mocked; the loop, the session log, and the plugin are real.
 */
async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ModesService)
  ctx.llm.registerAdapter(['mock'], adapter)
  for (const name of ['read', 'write']) {
    ctx.tools.register(defineTool({
      name,
      description: `test tool ${name}`,
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: `ran ${name}` }]),
    }))
  }
  return ctx
}

function waitForIdle(ctx: Context, agent: ReactLoopAgent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function findEvent<T extends SessionEvent['type']>(
  log: readonly SessionEvent[],
  type: T,
  position: 'first' | 'last' = 'first',
): Extract<SessionEvent, { type: T }> {
  const found = position === 'first'
    ? log.find(event => event.type === type)
    : log.findLast(event => event.type === type)
  if (!found) throw new Error(`no ${type} event in the session log`)
  return found as Extract<SessionEvent, { type: T }>
}

describe('plan mode through the agent loop', () => {
  it('seeds plan mode from AgentOptions: the FIRST header is already plan-shaped and the gate denies a write', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'write', {}, 'Trying to write anyway.'),
      textResponse('Back to planning.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('it-plan-seed'), { model: 'mock', mode: PLAN_MODE })

    agent.send([{ type: 'text', text: 'explore the repo' }])
    await waitForIdle(ctx, agent)

    const log = agent.session.events
    const modeSet = findEvent(log, 'mode/set')
    const header = findEvent(log, 'request/header')
    expect(modeSet.seq).toBeLessThan(header.seq)
    expect(header.data.reason).toBe('initial')
    expect(header.data.header.tools?.map(tool => tool.name)).toEqual(['read'])
    expect(header.data.header.system).toContain('plan mode')

    const result = findEvent(log, 'tool/result')
    expect(result.data.isError).toBe(true)
    expect(foldMode(log)).toBe(PLAN_MODE)
    expect(log.some(event => event.type === 'context/message')).toBe(false)
  })

  it('a user flip between turns lands at the boundary: one notice and the widening header delta', async () => {
    const adapter = new MockAdapter([
      textResponse('First turn, default mode.'),
      textResponse('Second turn, plan mode.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('it-plan-flip'), { model: 'mock' })

    agent.send([{ type: 'text', text: 'hello' }])
    await waitForIdle(ctx, agent)
    expect(foldMode(agent.session.events)).toBe('default')

    ctx.modes.set(agent, PLAN_MODE)
    agent.send([{ type: 'text', text: 'now plan' }])
    await waitForIdle(ctx, agent)

    const log = agent.session.events
    expect(foldMode(log)).toBe(PLAN_MODE)
    const notices = log.filter(event => event.type === 'context/message')
    expect(notices).toHaveLength(1)
    expect(findEvent(log, 'context/message').data.content).toEqual([
      { type: 'text', text: 'The user switched this session to plan mode.' },
    ])
    const delta = findEvent(log, 'request/header-delta')
    expect(delta.data.tools).toBeDefined()
    expect(delta.data.system).toBeDefined()
  })
})
