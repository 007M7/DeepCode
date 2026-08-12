import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage, CallId  } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import CordisHostRunner from '@deepseek-ai/dsh-cordis-host-runner'
import * as ToolCordis from '../src/index.ts'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { call, REVERSE_TOOL_CODE, setup, text } from './helpers.ts'

/**
 * Full-loop integration: a scripted mock model defines and runs a package that
 * registers a NEW tool, calls that tool on the very next step (tool schemas are
 * reassembled per step — the real loop proves the self-extension contract), and
 * undefines it again. Only the model is mocked; the sandbox, the fiber tree, and
 * the session log are real — including the presentation metadata the card needs.
 */

async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(CordisHostRunner)
  await ctx.plugin(ToolCordis)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

describe('cordis tools through the agent loop', () => {
  it('defines, runs, calls, and undefines a self-made tool — all as real tool/call events', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'cordis_define', { name: 'reverser', purpose: 'reverses text', code: REVERSE_TOOL_CODE }, 'Extending myself.'),
      toolCallResponse('call-2', 'cordis_run', { id: 'dyn-1' }),
      toolCallResponse('call-3', 'reverse_text', { text: 'harness' }),
      toolCallResponse('call-4', 'cordis_undefine', { id: 'dyn-1' }),
      textResponse('Done.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-cordis'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'give yourself reverse_text, use it, clean up' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = agent.session.events
    const calls = log.filter(event => event.type === 'tool/call').map(event => event.data.name)
    expect(calls).toEqual(['cordis_define', 'cordis_run', 'reverse_text', 'cordis_undefine'])

    const results = log.filter(event => event.type === 'tool/result')
    expect(results.map(event => event.data.message.content[0].isError)).toEqual([false, false, false, false])
    // The define result's durable metadata carries the minted id — this is what
    // a card reads to address run/stop, and replay reproduces it verbatim.
    expect(results[0]!.data.meta).toEqual({ id: 'dyn-1' })
    const reversed = results[2]!.data.message.content[0].content
      .filter(block => block.type === 'text')
      .map(block => block.text)
      .join('')
    expect(reversed).toBe('ssenrah')

    // After the undefine the self-made tool is gone from the registry.
    expect(ctx.tools.get('reverse_text')).toBeUndefined()
  })

  it('keeps a running package across turns, undefines it, and does not restore it in a new runtime', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('define-1', 'cordis_define', { name: 'marker', purpose: 'marks the turn', code: 'return { name: \'turn-marker\', apply() {} }' }),
      toolCallResponse('run-1', 'cordis_run', { id: 'dyn-1' }),
      toolCallResponse('inspect-1', 'cordis_runtime_inspect', { what: 'temporary' }),
      textResponse('Turn one complete.'),
      toolCallResponse('inspect-2', 'cordis_runtime_inspect', { what: 'temporary' }),
      toolCallResponse('undefine-1', 'cordis_undefine', { id: 'dyn-1' }),
      toolCallResponse('inspect-3', 'cordis_runtime_inspect', { what: 'temporary' }),
      textResponse('Turn two complete.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-cordis-turn-lifetime'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Define and run the marker, then inspect it.' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'On this later turn, inspect the marker, undefine it, then inspect again.' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const resultText = new Map(
      agent.session.events
        .filter(event => event.type === 'tool/result')
        .map(event => [event.data.message.source.callId, event.data.message.content[0].content.filter(block => block.type === 'text').map(block => block.text).join('')]),
    )
    expect(resultText.get(CallId('inspect-1'))).toContain('- dyn-1: marker [running, rev 1] (host) — marks the turn')
    expect(resultText.get(CallId('inspect-2'))).toContain('- dyn-1: marker [running, rev 1] (host) — marks the turn')
    expect(resultText.get(CallId('undefine-1'))).toBe('Dynamic package dyn-1 is stopped and undefined; its id is now invalid.')
    expect(resultText.get(CallId('inspect-3'))).toContain('No dynamic packages are defined in this session.')

    // A fresh runtime restores nothing: definitions never left this process.
    const restarted = await setup()
    expect(text(await call(restarted, 'cordis_runtime_inspect', { what: 'temporary' })))
      .toContain('No dynamic packages are defined in this session.')
  })
})
