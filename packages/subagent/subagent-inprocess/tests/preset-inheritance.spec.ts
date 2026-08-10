/**
 * Composition inheritance: a child runs on the preset its parent runs on.
 *
 * With every model-facing row on the agent plane, the tool registry's global
 * layer is empty, so a child that joins no preset reaches the model with no
 * tools at all. These assert the model-visible result — the schemas in the
 * child's own request — rather than the join that produces it.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import Include from '@cordisjs/plugin-include'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import AgentPresets from '@deepseek-ai/dsh-agent-presets'
import { SessionId } from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { startInProcessRun } from '../src/index.ts'

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures')
const ROOTS = [{ path: join(FIXTURES, 'presets'), trust: 'system' as const }]

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

/** A host composition carrying no model-facing rows, plus the preset roster. */
async function setupPresetHost(): Promise<{ ctx: Context; adapter: MockAdapter; parent: Agent }> {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.baseUrl = pathToFileURL(FIXTURES).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(AgentPresets, { default: 'coding', roots: ROOTS })
  const adapter = new MockAdapter([textResponse('parent idle'), textResponse('child done')])
  ctx.llm.registerAdapter(['mock'], adapter)
  const handle = await ctx.agents.create({
    sessionId: SessionId('parent'),
    agentOptions: { provider: 'mock', model: 'mock' },
    setup: async (agentCtx: Context) => void await ctx.agentPresets.mount(agentCtx, 'coding'),
  })
  return { ctx, adapter, parent: handle.agent }
}

/** The one-shot spawn request shape both in-process providers build. */
function spawnRequest(parent: Agent) {
  return {
    label: 'child task',
    prompt: [{ type: 'text' as const, text: 'child task' }],
    parent,
    signal: new AbortController().signal,
    descriptor: snapshotSubagentDescriptor({
      mode: 'one-shot' as const,
      provider: 'spawn',
      label: 'child task',
    }),
  }
}

describe('a child agent composed in-process', () => {
  it('reaches the model with its parent\'s preset tools', async () => {
    const { ctx, adapter, parent } = await setupPresetHost()

    const run = await startInProcessRun(spawnRequest(parent), {})
    await run.result

    const childRequest = adapter.requests.at(-1)
    expect(childRequest?.tools?.map(tool => tool.name)).toEqual(['preset_only'])
    expect(ctx.tools.schemas(run.localAgent).map(schema => schema.name)).toEqual(['preset_only'])
    await run.dispose()
  })

  it('carries its parent\'s prompt sections', async () => {
    const { parent } = await setupPresetHost()

    const run = await startInProcessRun(spawnRequest(parent), {})
    await run.result

    expect(run.localAgent?.session.events.some(event =>
      event.type === 'request/header'
      && JSON.stringify(event.data).includes('section for preset_only'))).toBe(true)
    await run.dispose()
  })

  it('records the composition it ran under on the child header', async () => {
    const { parent } = await setupPresetHost()

    const run = await startInProcessRun(spawnRequest(parent), {})
    await run.result

    // Without this the child's own history reads back under the deployment
    // default, which is a different tool set than the one it actually used.
    expect(run.localAgent?.session.header.agentPreset).toBe('coding')
    await run.dispose()
  })

  it('follows a parent that switched preset while blank', async () => {
    const { ctx, parent } = await setupPresetHost()
    await ctx.agentPresets.recompose(parent.ctx, 'coding')

    const run = await startInProcessRun(spawnRequest(parent), {})
    await run.result

    expect(ctx.tools.schemas(run.localAgent).map(schema => schema.name)).toEqual(['preset_only'])
    await run.dispose()
  })
})
