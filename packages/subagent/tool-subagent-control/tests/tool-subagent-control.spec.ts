import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import SubagentService from '@deepseek-ai/dsh-subagent'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn'
import LocalTaskService from '@deepseek-ai/dsh-tasks-local'
import * as ToolTasks from '@deepseek-ai/dsh-tool-tasks'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import * as tool from '../src/index.ts'

const testToolSignal = new AbortController().signal

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function setup(script: ConstructorParameters<typeof MockAdapter>[0]) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'dsh-tool-subagent-control-'))
  roots.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(LocalTaskService)
  await ctx.plugin(ToolTasks, {})
  await ctx.plugin(tool)
  const adapter = new MockAdapter(script)
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, adapter }
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

let calls = 0
function callTool(
  ctx: Context,
  name: string,
  args: unknown,
  agent?: unknown,
  signal: AbortSignal = testToolSignal,
) {
  return ctx.tools.execute({
    signal,
    callId: CallId(`call-${++calls}`),
    name,
    arguments: args,
    ...agent !== undefined ? { agent: agent as never } : {},
  })
}

describe('dsh-tool-subagent-control', () => {
  it('registers send_message once, globally, with the two required parameters', async () => {
    const { ctx } = await setup([])
    const schemas = ctx.tools.schemas().filter(schema => schema.name === 'send_message')
    expect(schemas).toHaveLength(1)
    const props = (schemas[0]!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props).sort()).toEqual(['message', 'subagent_id'])
    expect(schemas[0]!.description).toContain('task_output')
  })

  it('cold-resumes a settled child and renders the started route with its task id', async () => {
    const { ctx, parent } = await setup([textResponse('first answer'), textResponse('second answer')])
    const started = ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'work',
      request: { prompt: [{ type: 'text', text: 'child task' }], parent },
    })
    await ctx.tasks.wait(started.taskId, 5_000, parent)

    const result = await callTool(ctx, 'send_message', {
      subagent_id: started.childId,
      message: 'and then?',
    }, parent)
    expect(result.isError).toBe(false)
    expect(text(result)).toBe(`message started task subagent-2 continuing subagent ${started.childId}`)
    const collected = await callTool(ctx, 'task_output', { task_id: 'subagent-2', wait: true }, parent)
    expect(text(collected)).toBe('second answer\n[status: completed]')
    const loaded = await ctx.sessionPersistence.load(started.childId)
    const followUp = loaded.events.findLast(event =>
      event.type === 'user/message',
    )
    expect(followUp?.type === 'user/message' && followUp.data.source).toEqual({
      kind: 'coordinator',
      senderSessionId: parent.id,
    })
  })

  it('renders the steered route when the child is still running', async () => {
    // Script the child's single turn as two steps: the steer joins mid-turn.
    const { ctx, parent } = await setup([])
    let steered: string | undefined
    let source: unknown
    // Reach past the tool into the subagent service to fake a running route
    // deterministically: the tool is a thin adapter, so its steered wording is
    // what this test pins.
    ctx.subagents.followup = async (agent, _childId, message, options) => {
      steered = (message[0] as { text: string }).text
      source = options.source
      return { route: 'steered', taskId: ctx.tasks.list(agent)[0]?.id ?? ('subagent-9' as never) }
    }
    const result = await callTool(ctx, 'send_message', {
      subagent_id: 'some-child',
      message: 'also consider Y',
    }, parent)
    expect(result.isError).toBe(false)
    expect(steered).toBe('also consider Y')
    expect(source).toEqual({ kind: 'coordinator', senderSessionId: parent.id })
    expect(text(result)).toBe('message delivered to running task subagent-9')
  })

  it('cancels a pending live-delivery wait when the tool signal aborts', async () => {
    const { ctx, parent, adapter } = await setup(['hang'])
    const started = ctx.subagents.startContinuable({
      provider: 'spawn',
      label: 'hung work',
      request: { prompt: [{ type: 'text', text: 'wait' }], parent },
    })
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const deliveryStarted: PromiseWithResolvers<void> = Promise.withResolvers()
    const followup = ctx.subagents.followup.bind(ctx.subagents)
    ctx.subagents.followup = (agent, childId, message, options) => {
      const delivery = followup(agent, childId, message, options)
      deliveryStarted.resolve()
      return delivery
    }

    const controller = new AbortController()
    const execution = callTool(ctx, 'send_message', {
      subagent_id: started.childId,
      message: 'follow up',
    }, parent, controller.signal)
    await deliveryStarted.promise
    controller.abort('parent tool cancelled')

    const result = await execution
    expect(result.isError).toBe(true)
    expect(result.error?.info?.code).toBe('CANCELLED')
    expect(ctx.agents.get(started.childId)).toBeUndefined()
    const snapshot = await ctx.tasks.wait(started.taskId, 5_000, parent)
    expect(snapshot.status).toBe('killed')
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(loaded.events.some(event => event.type === 'steering/message')).toBe(false)
  })

  it('reports a delivery failure as an errored, not-delivered result', async () => {
    const { ctx, parent } = await setup([])
    const result = await callTool(ctx, 'send_message', {
      subagent_id: 'no-such-child',
      message: 'hello?',
    }, parent)
    // Unknown ids start a Task whose failure carries the unavailable detail;
    // synchronous rejections (ownership conflicts) become isError results.
    if (result.isError) {
      expect(text(result)).toContain('not delivered')
    } else {
      const taskId = text(result).match(/task (\S+) /)?.[1]
      expect(taskId).toBeDefined()
      const snapshot = await ctx.tasks.wait(taskId as never, 5_000, parent)
      expect(snapshot.status).toBe('failed')
      expect(snapshot.detail).toContain('unavailable')
    }
  })

  it('fails loud when invoked without a calling agent', async () => {
    const { ctx } = await setup([])
    const result = await callTool(ctx, 'send_message', { subagent_id: 'x', message: 'y' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('requires a calling agent')
  })

  it('unregisters with its plugin fiber (HMR safety)', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(SubagentService)
    await ctx.plugin(LocalTaskService)
    const fiber = await ctx.plugin(tool)
    expect(ctx.tools.schemas().some(schema => schema.name === 'send_message')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(schema => schema.name === 'send_message')).toBe(false)
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-subagent-control')
    expect(tool.inject).toEqual(['tools', 'subagents'])
    expect(typeof tool.apply).toBe('function')
  })
})
