import { describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { AgentId } from '@deepseek-ai/dsh-agent'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter } from './mock-adapter.ts'

async function harness() {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
  return ctx
}

describe('agent disposal drains onCleanup registrations', () => {
  it('awaits the cleanup after loop drain and before unregistration', async () => {
    const ctx = await harness()
    const handle = ctx.agents.create({ agentId: AgentId('owner'), sessionId: SessionId('owner-sess'), agentOptions: { model: 'mock' } })

    const order: string[] = []
    ctx.on('agent/disposed', () => void order.push('agent/disposed'))
    let cleanupSettled = false
    ctx.agents.onCleanup(handle.agent.id, async () => {
      // The agent must STILL be registered while cleanups drain (a settling
      // task's completion notice can still find it by session id).
      order.push(`cleanup:registered=${ctx.agents.get(handle.agent.id) !== undefined}`)
      await new Promise(r => setTimeout(r, 10))
      cleanupSettled = true
      order.push('cleanup:done')
    })

    await handle.dispose()
    // dispose() resolves only after the cleanup settled (awaited, not fired).
    expect(cleanupSettled).toBe(true)
    expect(order).toEqual(['cleanup:registered=true', 'cleanup:done', 'agent/disposed'])
  })

  it('a rejecting cleanup never breaks the disposal chain', async () => {
    const ctx = await harness()
    const warn = vi.spyOn(ctx.logger, 'warn').mockImplementation(() => {})
    const handle = ctx.agents.create({ agentId: AgentId('owner'), sessionId: SessionId('owner-sess'), agentOptions: { model: 'mock' } })
    ctx.agents.onCleanup(handle.agent.id, () => Promise.reject(new Error('drain boom')))

    await expect(handle.dispose()).resolves.toBeUndefined()
    expect(ctx.agents.get(handle.agent.id)).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('drain boom'))
  })
})
