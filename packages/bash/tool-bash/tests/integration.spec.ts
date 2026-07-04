import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import AgentLoop, { ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import { BashTaskId } from '@deepseek-ai/dsh-bash'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Full-loop integration: a scripted mock model drives the REAL bash tool
 * through the agent loop, exercising the same seams a live model would
 * (tool/call + tool/result session events, agent.inject notifications).
 */
async function harness(adapter: MockAdapter) {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(ToolBash)
  ctx.llm.registerAdapter(['mock'], adapter)
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

function events(agent: ReactLoopAgent): SessionEvent[] {
  return [...agent.session.events]
}

/** Find a session event by type, narrowed; throws when absent. */
function findEvent<T extends SessionEvent['type']>(
  log: SessionEvent[],
  type: T,
  position: 'first' | 'last' = 'first',
): Extract<SessionEvent, { type: T }> {
  const found = position === 'first'
    ? log.find(event => event.type === type)
    : log.findLast(event => event.type === type)
  if (!found) throw new Error(`no ${type} event in the session log`)
  return found as Extract<SessionEvent, { type: T }>
}

function resultText(event: SessionEvent): string {
  if (event.type !== 'tool/result') return ''
  return event.data.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

describe('bash tool through the agent loop', () => {
  it('foreground: model calls bash, sees the result, replies', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', { command: 'echo integration-ok', description: 'test command' }, 'Running it.'),
      textResponse('The command printed integration-ok.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('it-fg'), { model: 'mock' })

    agent.send([{ type: 'text', text: 'run echo integration-ok' }])
    await waitForIdle(ctx, agent)

    const log = events(agent)
    const toolCall = findEvent(log, 'tool/call')
    expect(toolCall.data.name).toBe('bash')

    const toolResult = findEvent(log, 'tool/result')
    expect(toolResult.data.isError).toBe(false)
    expect(resultText(toolResult)).toBe('integration-ok\n')

    // The second model call saw the tool result in its derived history.
    const lastRequest = adapter.requests.at(-1)
    const toolResultBlocks = (lastRequest?.messages ?? [])
      .flatMap(message => message.content)
      .filter(block => block.type === 'tool-result')
    expect(toolResultBlocks).toHaveLength(1)

    const finalMessage = findEvent(log, 'assistant/message', 'last')
    expect(finalMessage.data.content.some(
      block => block.type === 'text' && block.text.includes('integration-ok'),
    )).toBe(true)
  })

  it('foreground: non-zero exit is reported in the result text, not as isError', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', { command: 'exit 9', description: 'test command' }),
      textResponse('It failed with code 9.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('it-exit'), { model: 'mock' })

    agent.send([{ type: 'text', text: 'run exit 9' }])
    await waitForIdle(ctx, agent)

    const toolResult = findEvent(events(agent), 'tool/result')
    expect(toolResult.data.isError).toBe(false)
    expect(resultText(toolResult)).toContain('[exit code: 9]')
  })

  it('background: start → poll → completion notice lands as context/message', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', { command: 'echo bg-ok', description: 'test command', run_in_background: true }),
      toolCallResponse('call-2', 'bash_output', {}, undefined),
      textResponse('Background task finished.'),
    ])
    // The second tool call needs the REAL task id from the first result;
    // a tools/pre-execute listener rewrites the scripted arguments. (This uses
    // the low-level capability to mutate `exec` before dispatch — the
    // unadvertised mechanism behind a future first-class input-rewrite decision;
    // here it is a test shim to thread the generated id, not a product feature.)
    let taskId = ''

    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('it-bg'), { model: 'mock' })

    // Intercept the first tool result to capture the generated task id, then
    // rewrite the second scripted call's arguments to use it.
    ctx.on('session/event', (_session, event) => {
      if (event.type === 'tool/result' && taskId === '') {
        const match = /task (bash-\d+)/.exec(resultText(event))
        if (match) taskId = match[1]!
      }
    })
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'bash_output') {
        exec.arguments = { task_id: taskId }
      }
      return next()
    })

    agent.send([{ type: 'text', text: 'run echo bg-ok in the background' }])
    await waitForIdle(ctx, agent)

    // Wait for the background task itself (completion may race turn end).
    const task = ctx.bash.get(BashTaskId(taskId))
    if (!task) throw new Error(`task ${taskId} not registered`)
    await task.done

    const log = events(agent)
    const firstResult = findEvent(log, 'tool/result')
    expect(resultText(firstResult)).toBe(`started background task ${taskId}`)

    const notice = findEvent(log, 'context/message')
    expect(notice.data.content.some(
      block => block.type === 'text' && block.text.includes(`background bash task ${taskId} finished`),
    )).toBe(true)
    expect(notice.data.source).toEqual({ kind: 'plugin', plugin: 'tool-bash' })
  })
})
