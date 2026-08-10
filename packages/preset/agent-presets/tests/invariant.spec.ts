import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import InvariantService from '@deepseek-ai/dsh-invariants'
import { describe, expect, it } from 'vitest'
import AgentPresets, { livePresetMounts } from '@deepseek-ai/dsh-agent-presets'
import * as AgentPresetsInvariant from '@deepseek-ai/dsh-agent-presets/invariant'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const ROOTS = [
  { path: join(FIXTURES, 'system'), trust: 'system' as const },
  { path: join(FIXTURES, 'user'), trust: 'user' as const },
]

async function harness(): Promise<Context> {
  const ctx = new Context()
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'standard', roots: ROOTS })
  await ctx.plugin(InvariantService)
  await ctx.plugin(AgentPresetsInvariant)
  return ctx
}

describe('agent-presets invariants', () => {
  it('keeps the standing composition alive across the agents that joined it', async () => {
    const ctx = await harness()
    const handle = await ctx.agents.create({
      sessionId: SessionId('inv-live'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })

    expect(livePresetMounts().map(mount => mount.presetId)).toContain('standard')

    // A standing mount survives its agents: the composition a session joined
    // is shared, so one session ending must not strip it from the next.
    await handle.dispose()
    expect(livePresetMounts().map(mount => mount.presetId)).toContain('standard')

    // A second agent reuses the same mount rather than adding one.
    await ctx.agents.create({
      sessionId: SessionId('inv-live-2'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'standard'),
    })
    expect(livePresetMounts().filter(mount => mount.presetId === 'standard')).toHaveLength(1)

    // Whole-tree teardown is the boundary that does reclaim it.
    await ctx.fiber.dispose()
    expect(livePresetMounts().map(mount => mount.presetId)).not.toContain('standard')
  })

  it('rejects a composition that publishes a process-global service after its audit', async () => {
    const ctx = await harness()
    await ctx.agents.create({
      sessionId: SessionId('inv-late'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'late'),
    })
    const publishLate = (globalThis as { __PUBLISH_LATE__?: () => void }).__PUBLISH_LATE__
    expect(publishLate).toBeTypeOf('function')

    expect(() => { publishLate?.() }).toThrow(/published process-global service\(s\) \[fixtureLateSvc\]/)
  })

  it('stays quiet while every composition keeps its services out of the root realm', async () => {
    const ctx = await harness()

    await expect(ctx.agents.create({
      sessionId: SessionId('inv-isolated'),
      setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'isolated'),
    })).resolves.toBeDefined()
  })
})
