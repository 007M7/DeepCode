import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Invariants from '@deepseek-ai/dsh-invariants'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentService from '@deepseek-ai/dsh-subagent'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-inprocess'
import * as spawn from '@deepseek-ai/dsh-subagent-spawn'
import WorkerWorkflowEngine from '@deepseek-ai/dsh-workflow-workerthread'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as toolRalph from '../src/index.ts'

describe('dsh-tool-ralph over the real spawn and worker-thread stack', () => {
  it('uses distinct empty-seed children, shared cwd, and only the prior bounded handoff', async () => {
    const firstReport = {
      status: 'continue',
      summary: 'ROUND_ONE_HANDOFF',
      evidence: ['Created migration-a.ts.'],
      nextSteps: ['Finish migration-b.ts.'],
      blocker: '',
    }
    const finalReport = {
      status: 'complete',
      summary: 'Both migration slices are complete.',
      evidence: ['Focused migration tests pass.'],
      nextSteps: [],
      blocker: '',
    }
    const ctx = new Context()
    const adapter = new MockAdapter([
      textResponse('PARENT_HISTORY_MARKER'),
      toolCallResponse('round-1', STRUCTURED_OUTPUT_TOOL, firstReport),
      toolCallResponse('round-2', STRUCTURED_OUTPUT_TOOL, finalReport),
    ])
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(Invariants)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    await ctx.plugin(spawn, { providerName: 'spawn' })
    await ctx.plugin(WorkerWorkflowEngine, {})
    await ctx.plugin(toolRalph, { maxRounds: 2 })
    ctx.llm.registerAdapter(['mock'], adapter)

    const parentHandle = await ctx.agents.create({
      sessionId: SessionId('ralph-parent'),
      meta: { cwd: '/tmp/ralph-shared-workspace' },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    const parent = parentHandle.agent
    parent.send([{ type: 'text', text: 'PARENT_PROMPT_MARKER' }])
    await parent.whenIdle()

    const children: Agent[] = []
    ctx.on('workflow/agent-start', (_run, child) => {
      const agent = ctx.agents.get(child.childId)
      expect(agent).toBeDefined()
      children.push(agent!)
    })
    const result = await ctx.tools.execute({
      callId: CallId('ralph-integration'),
      name: 'ralph',
      arguments: { objective: 'Complete both migration slices.', maxRounds: 2 },
      agent: parent,
    })

    expect(result.isError).toBe(false)
    expect((result.content[0] as { text: string }).text).toContain('Ralph completed after 2 rounds.')
    expect(children).toHaveLength(2)
    expect(new Set(children.map(child => child.id)).size).toBe(2)
    for (const child of children) {
      expect(child.session.header.cwd).toBe('/tmp/ralph-shared-workspace')
      expect(child.session.header.parentSession).toBe(parent.session.header.id)
      expect(child.session.header.seedLength).toBeUndefined()
      expect(ctx.agents.get(child.id)).toBeUndefined()
    }

    expect(adapter.requests).toHaveLength(3)
    const firstChildRequest = JSON.stringify(adapter.requests[1]!.messages)
    const secondChildRequest = JSON.stringify(adapter.requests[2]!.messages)
    expect(firstChildRequest).not.toContain('PARENT_PROMPT_MARKER')
    expect(firstChildRequest).not.toContain('PARENT_HISTORY_MARKER')
    expect(firstChildRequest).not.toContain('ROUND_ONE_HANDOFF')
    expect(secondChildRequest).not.toContain('PARENT_PROMPT_MARKER')
    expect(secondChildRequest).not.toContain('PARENT_HISTORY_MARKER')
    expect(secondChildRequest).toContain('ROUND_ONE_HANDOFF')

    await parentHandle.dispose()
  })
})
