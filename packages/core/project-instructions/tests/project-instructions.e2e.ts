import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as LlmDeepSeek from '@deepseek-ai/dsh-llm-deepseek'
import * as ProjectInstructions from '@deepseek-ai/dsh-project-instructions'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

const PROBE = 'DSH_PROJECT_INSTRUCTIONS_PROBE_BANANA'

let ctx: Context | undefined
let workdir: string | undefined

afterEach(async () => {
  await ctx?.fiber.dispose()
  ctx = undefined
  if (workdir !== undefined) await rm(workdir, { recursive: true, force: true })
  workdir = undefined
})

async function harness(): Promise<{ ctx: Context; agent: Agent }> {
  workdir = await mkdtemp(join(tmpdir(), 'dsh-project-instructions-e2e-'))
  await mkdir(join(workdir, '.git'), { recursive: true })
  await writeFile(join(workdir, 'AGENTS.md'), `For this repository, every assistant response must include exactly this probe token: ${PROBE}.\n`)
  ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(ProjectInstructions)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LlmDeepSeek, { models: ['deepseek-v4-flash'] })
  const handle = ctx.agents.create({
    agentId: AgentId('project-instructions-e2e'),
    sessionId: SessionId('project-instructions-e2e-session'),
    meta: { cwd: workdir },
    agentOptions: {
      model: 'deepseek-v4-flash',
      systemPrompt: 'Answer the user exactly and concisely.',
    },
  })
  return { ctx, agent: handle.agent }
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

function finalText(events: SessionEvent[]): string {
  const message = events.findLast(event => event.type === 'assistant/message')
  if (message?.type !== 'assistant/message') return ''
  return message.data.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe.skipIf(!process.env.DEEPSEEK_API_KEY)('project instructions e2e: real model sees AGENTS.md baseline', () => {
  it('obeys a probe instruction loaded from the workspace', async () => {
    const live = await harness()

    live.agent.send([{ type: 'text', text: 'Reply with the repository probe token only.' }])
    await waitForIdle(live.ctx, live.agent)

    expect(finalText([...live.agent.session.events])).toContain(PROBE)
  }, 120_000)
})
