import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ToolCordis from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { REVERSE_TOOL_CODE } from './helpers.ts'

/**
 * Full-loop integration: a scripted mock model mounts a plugin that registers
 * a NEW tool, calls that tool on the very next step (tool schemas are
 * reassembled per step — the real loop proves the self-extension contract),
 * and unmounts it again. Only the model is mocked; the sandbox, the fiber
 * tree, and the session log are real.
 */

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ToolCordis)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe('cordis tools through the agent loop', () => {
  it('mounts a tool, calls it on the next step, and unmounts it — all as real tool/call events', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'cordis_mount', { code: REVERSE_TOOL_CODE }, 'Extending myself.'),
      toolCallResponse('call-2', 'reverse_text', { text: 'harness' }),
      toolCallResponse('call-3', 'cordis_unmount', { id: 'dyn-1' }),
      textResponse('Done.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-cordis'), { provider: 'mock', model: 'mock' })

    agent.followup({ content: [{ type: 'text', text: 'give yourself reverse_text, use it, clean up' }], source: { kind: 'user' } })
    await waitForIdle(ctx, agent)

    const log = agent.session.events
    const calls = log.filter(event => event.type === 'tool/call').map(event => event.data.name)
    expect(calls).toEqual(['cordis_mount', 'reverse_text', 'cordis_unmount'])

    const results = log.filter(event => event.type === 'tool/result')
    expect(results.map(event => event.data.isError)).toEqual([false, false, false])
    const reversed = results[1]!.data.content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(reversed).toBe('ssenrah')

    // After the unmount the self-made tool is gone from the registry.
    expect(ctx.tools.get('reverse_text')).toBeUndefined()
  })
})
