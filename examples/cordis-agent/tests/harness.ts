import { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import * as ToolCordis from '@deepseek-ai/dsh-tool-cordis'

/**
 * Shared harness for the cordis-agent e2e suite: the agent spine with the real
 * DeepSeek adapter and the real `@deepseek-ai/dsh-tool-cordis` plugin, so a
 * live model can mount plugins into the very context the test observes. Lives
 * outside the *.e2e.ts pattern so importing it never re-registers another
 * file's tests.
 */

const PERSONA = 'You are cordis-agent, a self-referential harness demo. '
  + 'Your cordis_* tools operate on the live cordis runtime you run inside: '
  + 'cordis_inspect to look around, cordis_mount to mount a temporary Plugin, cordis_unmount '
  + 'to unmount one. Follow the tool descriptions exactly and report results briefly.'

export async function cordisHarness(): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx, {
    systemPrompt: { persona: PERSONA },
  })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepSeek)
  await ctx.plugin(ToolCordis)
  return ctx
}

export function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', (subject, status) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}
