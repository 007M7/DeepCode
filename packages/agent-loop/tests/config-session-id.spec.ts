import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import AgentLoop, { LoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { MockAdapter, textResponse } from './mock-adapter.ts'

const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })

function waitForIdle(ctx: Context, agent: LoopAgent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') { dispose(); resolve() }
    })
  })
}

describe('config-driven session id', () => {
  it('config-driven create uses a fresh ${id}-session-<uuid> per run (restart-safe)', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-cfg-session-'))
    dirs.push(root)
    const idPattern = /^cfg-session-[0-9a-f-]{36}$/
    // Run 1: a config agent persists a turn under a generated session id.
    const ctx1 = new Context()
    await ctx1.plugin(LlmService)
    await ctx1.plugin(SessionStore)
    await ctx1.plugin(SystemPrompt)
    await ctx1.plugin(ToolRegistry)
    await ctx1.plugin(AgentRegistry)
    await ctx1.plugin(AgentLoop, { agents: [{ id: 'cfg', model: 'mock', systemPrompt: '' }] })
    await ctx1.plugin(SessionPersistenceJsonl, { root })
    ctx1.llm.registerAdapter(['mock'], new MockAdapter([textResponse('cfg')]))
    const a1 = ctx1.agents.get('cfg') as LoopAgent
    expect(a1.session.id).toMatch(idPattern)
    a1.send([{ type: 'text', text: 'q' }], { source: { kind: 'user' } })
    await waitForIdle(ctx1, a1)
    await ctx1.fiber.dispose()

    // Run 2 over the SAME root: a fresh id means no on-disk collision (a fixed
    // ${id}-session would crash here with "already has a persisted log").
    const ctx2 = new Context()
    await ctx2.plugin(LlmService)
    await ctx2.plugin(SessionStore)
    await ctx2.plugin(SystemPrompt)
    await ctx2.plugin(ToolRegistry)
    await ctx2.plugin(AgentRegistry)
    await ctx2.plugin(AgentLoop, { agents: [{ id: 'cfg', model: 'mock', systemPrompt: '' }] })
    await ctx2.plugin(SessionPersistenceJsonl, { root })
    ctx2.llm.registerAdapter(['mock'], new MockAdapter([textResponse('cfg2')]))
    const a2 = ctx2.agents.get('cfg') as LoopAgent
    expect(a2.session.id).toMatch(idPattern)
    expect(a2.session.id).not.toBe(a1.session.id)
    a2.send([{ type: 'text', text: 'q2' }], { source: { kind: 'user' } })
    await waitForIdle(ctx2, a2)
    await ctx2.fiber.dispose()
  })
})
