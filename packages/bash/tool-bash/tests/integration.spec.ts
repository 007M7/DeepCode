import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from 'cordis'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionPersistenceJsonl from '@deepseek-ai/dsh-session-persistence-jsonl'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import AgentLoop, { ReactLoopAgent } from '@deepseek-ai/dsh-agent-loop'
import TaskService from '@deepseek-ai/dsh-tasks'
import * as ToolTasks from '@deepseek-ai/dsh-tool-tasks'
import { LocalBashExecutor } from '@deepseek-ai/dsh-bash-local'
import * as ToolBash from '@deepseek-ai/dsh-tool-bash'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

/**
 * Full-loop integration: a scripted mock model drives the REAL bash tool
 * through the agent loop, exercising the same seams a live model would
 * (tool/call + tool/result session events, the generic `ctx.tasks` runtime,
 * agent.inject completion notices).
 */
async function harness(adapter: MockAdapter, sessionRoot?: string, dshHome?: string) {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  if (sessionRoot !== undefined) await ctx.plugin(SessionPersistenceJsonl, { root: sessionRoot })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TaskService)
  await ctx.plugin(ToolTasks)
  await ctx.plugin(LocalBashExecutor, { timeoutMs: 10_000 })
  await ctx.plugin(ToolBash, dshHome === undefined ? {} : { dshHome })
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

const dirs: string[] = []
afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

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

/** Poll until `predicate` holds (background settlement races turn end). */
async function pollUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(`condition not met within ${timeoutMs}ms`)
}

describe('bash tool through the agent loop', () => {
  it('first-turn bash receives session identity before the lazy JSONL file materializes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-bash-session-env-'))
    dirs.push(root)
    const dshHome = join(root, 'dsh-home')
    vi.stubEnv('DSH_STALE_PARENT', 'stale')
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', {
        command: 'printf \'%s\\n%s\\n%s\\n%s\\n%s\\n\' "$DSH_HOME" "$DSH_SHELL" "$DSH_SESSION_ID" "$DSH_SESSION_JSONL" "${DSH_STALE_PARENT-unset}"; if [ -e "$DSH_SESSION_JSONL" ]; then printf \'present\\n\'; else printf \'absent\\n\'; fi',
        description: 'inspect session environment',
      }),
      textResponse('Session environment inspected.'),
    ])
    const ctx = await harness(adapter, root, dshHome)
    const handle = await ctx.agents.create({
      agentId: AgentId('session-env'),
      sessionId: SessionId('session-env-id'),
      agentOptions: { model: 'mock' },
    })
    const agent = handle.agent as ReactLoopAgent
    const location = ctx.sessionPersistence.locate(agent.session.header)
    expect(location?.kind).toBe('jsonl')

    agent.send([{ type: 'text', text: 'inspect the current session' }])
    await waitForIdle(ctx, agent)

    const result = findEvent(events(agent), 'tool/result')
    expect(resultText(result)).toBe(`${dshHome}\n1\nsession-env-id\n${location?.path}\nunset\nabsent\n`)
    expect(existsSync(location!.path)).toBe(true)
    const header = JSON.parse(readFileSync(location!.path, 'utf8').split('\n')[0]!) as { type: string; id: string }
    expect(header).toMatchObject({ type: 'session', id: 'session-env-id' })
    await handle.dispose()
  })

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

  it('background: start ack → completion notice as context/message → task_output collects it', async () => {
    // The task id is deterministic (a fresh TaskService counts per kind from 1),
    // so the script can name `bash-1` without threading a generated id.
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'bash', { command: 'echo bg-ok', description: 'test command', run_in_background: true }),
      textResponse('Started it in the background.'),
      toolCallResponse('call-2', 'task_output', { task_id: 'bash-1' }),
      textResponse('Background task finished.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(AgentId('it-bg'), { model: 'mock' })

    agent.send([{ type: 'text', text: 'run echo bg-ok in the background' }])
    await waitForIdle(ctx, agent)

    const firstResult = findEvent(events(agent), 'tool/result')
    expect(firstResult.data.isError).toBe(false)
    expect(resultText(firstResult)).toBe('started background task bash-1')

    // The task settles on its own; the tool-tasks notice listener injects a
    // durable context/message into the owning agent's session (settlement may
    // race turn end, so poll for it).
    await pollUntil(() => events(agent).some(event => event.type === 'context/message'))
    const notice = findEvent(events(agent), 'context/message')
    expect(notice.data.content.some(
      block => block.type === 'text' && block.text.includes('background task bash-1 (bash: echo bg-ok) finished'),
    )).toBe(true)
    expect(notice.data.source).toEqual({ kind: 'plugin', plugin: 'tool-tasks' })

    // The next turn collects the output through the generic task tool.
    agent.send([{ type: 'text', text: 'collect it' }])
    await waitForIdle(ctx, agent)
    const readResult = findEvent(events(agent), 'tool/result', 'last')
    expect(readResult.data.isError).toBe(false)
    expect(resultText(readResult)).toContain('bg-ok')
    expect(resultText(readResult)).toContain('[status: completed, exit code: 0]')
  })
})
