import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from 'cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork'
import { TaskId } from '@deepseek-ai/dsh-tasks'
import LocalTaskService from '@deepseek-ai/dsh-tasks-local'
import * as ToolTasks from '@deepseek-ai/dsh-tool-tasks'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createUserMessage, HarnessError, LlmAdapter } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentService, {
  settleRun,
  SubagentError,
  SUBAGENT_DESCRIPTOR_VERSION,
} from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

/** One scripted response that may wait on a caller-released gate before streaming. */
interface GatedEntry {
  chunks: StreamChunk[]
  gate?: Promise<void>
}

/** Adapter whose entries can hold a model call open until the test releases it. */
class GatedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private script: GatedEntry[]) {
    super()
  }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const entry = this.script.shift()
    if (!entry) throw new Error('GatedAdapter: script exhausted')
    if (entry.gate) await entry.gate
    for (const chunk of entry.chunks) {
      if (options.signal?.aborted) throw new Error('aborted')
      yield chunk
    }
  }
}

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

/** Boot the full continuable stack: loop, persistence, providers, tasks, and subagents. */
async function setupWith(adapter: LlmAdapter, options: { persistence?: boolean } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  let disposePersistence: (() => Promise<void>) | undefined
  if (options.persistence !== false) {
    const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-continuation-'))
    roots.push(root)
    const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root })
    disposePersistence = () => persistenceFiber.dispose()
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  await ctx.plugin(LocalTaskService)
  await ctx.plugin(ToolTasks, {})
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, disposePersistence }
}

async function setup(script: Script, options: { persistence?: boolean } = {}) {
  const adapter = new MockAdapter(script)
  const { ctx, parent } = await setupWith(adapter, options)
  return { ctx, parent, adapter }
}

function startSpec(parent: Agent, provider = 'spawn') {
  return {
    provider,
    label: 'delegated work',
    request: { prompt: [{ type: 'text' as const, text: 'child task' }], parent },
  }
}

async function waitTerminal(ctx: Context, taskId: TaskId, parent: Agent) {
  return ctx.tasks.wait(taskId, 5_000, parent)
}

async function waitPublishedRun(ctx: Context, childId: SessionId): Promise<void> {
  const continuations = ctx.subagents as unknown as {
    continuations: { activations: Map<SessionId, { run: unknown }> }
  }
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      if (continuations.continuations.activations.get(childId)?.run !== undefined) {
        clearInterval(timer)
        resolve()
      }
    }, 5)
  })
}

function message(text: string) {
  return [{ type: 'text' as const, text }]
}

const coordinatorSource = {
  kind: 'coordinator',
  senderSessionId: SessionId('parent'),
} as const
const testSendSignal = new AbortController().signal

function followup(
  ctx: Context,
  parent: Agent,
  childId: SessionId,
  content: ReturnType<typeof message>,
  signal: AbortSignal = testSendSignal,
) {
  return ctx.subagents.followup(parent, childId, content, {
    source: { kind: 'user' },
    signal,
  })
}

describe('SubagentService.startContinuable', () => {
  it('returns both identities immediately; the Task settles with the child result after disposal', async () => {
    const { ctx, parent } = await setup([textResponse('first answer')])
    const started = ctx.subagents.startContinuable(startSpec(parent))
    expect(started.childId).toMatch(/[0-9a-f-]{36}/)
    expect(started.taskId).toBe('subagent-1')

    const snapshot = await waitTerminal(ctx, started.taskId, parent)
    expect(snapshot.status).toBe('completed')
    expect(ctx.tasks.read(started.taskId, parent).text).toBe('first answer')
    // Disposal ordering: the terminal Task leaves no live child Agent.
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })

  it('fails a continuable Task before dispatch when its provider has no resume capability', async () => {
    const { ctx, parent } = await setup([])
    const start = vi.fn(async () => { throw new Error('must not dispatch') })
    ctx.subagents.registerProvider({
      name: 'one-shot',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start,
    })

    const started = ctx.subagents.startContinuable(startSpec(parent, 'one-shot'))
    const snapshot = await waitTerminal(ctx, started.taskId, parent)

    expect(snapshot.status).toBe('failed')
    expect(snapshot.detail).toContain('does not support continuable children')
    expect(start).not.toHaveBeenCalled()
  })

  it('fails the Task when persistence detaches before the activation completes', async () => {
    const releaseResponse = Promise.withResolvers<undefined>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('unconfirmed answer'), gate: releaseResponse.promise },
    ])
    const { ctx, parent, disposePersistence } = await setupWith(adapter)
    const started = ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })

    await disposePersistence!()
    releaseResponse.resolve(undefined)

    const snapshot = await waitTerminal(ctx, started.taskId, parent)
    expect(snapshot.status).toBe('failed')
    expect(snapshot.detail).toContain('durability checkpoint failed')
    expect(snapshot.detail).toContain('required durability checkpoint has no registered listener')
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })

  it('publishes the service-allocated child id and appends the pre-turn descriptor', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    const seen: SessionEvent[] = []
    ctx.on('session/event', (session, event) => {
      if (session.id !== SessionId('parent')) seen.push(event)
    })
    const started = ctx.subagents.startContinuable(startSpec(parent))
    await waitTerminal(ctx, started.taskId, parent)

    const descriptorIndex = seen.findIndex(event => event.type === 'subagent/descriptor')
    const turnStartIndex = seen.findIndex(event => event.type === 'turn/start')
    const firstAssistant = seen.findIndex(event => event.type === 'assistant/message')
    expect(descriptorIndex).toBeLessThan(turnStartIndex)
    expect(descriptorIndex).toBeLessThan(firstAssistant)
    const descriptor = seen[descriptorIndex] as SessionEvent<'subagent/descriptor'>
    expect(descriptor.data).toEqual({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      provider: 'spawn',
      agentProvider: 'mock',
      agentModel: 'mock',
    })
    // Model-hidden: the descriptor never carries surface metadata.
    expect('surfaceOp' in descriptor).toBe(false)

    // The durable log kept the exact service-allocated id.
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(loaded.meta.id).toBe(started.childId)
    expect(loaded.meta.parentSession).toBe(SessionId('parent'))
    expect(loaded.events.some(event => event.type === 'subagent/descriptor')).toBe(true)
  })

  it.each(['block', 'throw'] as const)(
    'persists the descriptor before initial prompt admission can $0',
    async (outcome) => {
      const { ctx, parent, adapter } = await setup([])
      ctx.on('agent/prompt-submit', async (subject, _message, _signal, next) => {
        if (subject === parent) return next()
        if (outcome === 'block') return { kind: 'block', reason: 'blocked by policy' }
        throw new Error('prompt admission failed')
      })

      const started = ctx.subagents.startContinuable(startSpec(parent))
      const snapshot = await waitTerminal(ctx, started.taskId, parent)

      expect(snapshot.status).toBe('failed')
      expect(adapter.requests).toEqual([])
      const loaded = await ctx.sessionPersistence.load(started.childId)
      const descriptorIndexes = loaded.events.flatMap((event, index) =>
        event.type === 'subagent/descriptor' ? [index] : [])
      expect(descriptorIndexes).toHaveLength(1)
      expect(loaded.events.some(event => event.type === 'turn/start')).toBe(false)
    },
  )

  it('rejects synchronously with no Task when persistence is not configured', async () => {
    const { ctx, parent } = await setup([textResponse('unused')], { persistence: false })
    expect(() => ctx.subagents.startContinuable(startSpec(parent)))
      .toThrow(/require session persistence/)
    expect(ctx.tasks.list(parent)).toEqual([])
  })

  it('rolls back the activation when Task preflight throws', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const realStart = ctx.tasks.start.bind(ctx.tasks)
    ctx.tasks.start = () => { throw new Error('task preflight failed') }
    try {
      expect(() => ctx.subagents.startContinuable(startSpec(parent)))
        .toThrow('task preflight failed')
    } finally {
      ctx.tasks.start = realStart
    }
    const continuations = ctx.subagents as unknown as {
      continuations: { activations: Map<SessionId, unknown> }
    }
    expect(continuations.continuations.activations.size).toBe(0)
  })

  it('rejects a non-JSON descriptor input synchronously with no Task', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const spec = startSpec(parent)
    expect(() => ctx.subagents.startContinuable({
      ...spec,
      // A symbol survives the static ToolRestriction type only through this
      // cast — exactly the durable-boundary input the snapshot rejects.
      request: { ...spec.request, toolFilter: { deny: [Symbol('boom') as unknown as string] } },
    })).toThrow(/not losslessly JSON-serializable/)
    expect(ctx.tasks.list(parent)).toEqual([])
  })

  it('settles the Task as failed when provider startup fails after the ids were returned', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const spec = {
      provider: 'spawn',
      label: 'broken delegation',
      request: {
        prompt: [{ type: 'text' as const, text: 'child task' }],
        parent,
        // The spawn provider enforces depth: parent depth 0 → child depth 1 > 0.
        maxDepth: 0,
      },
    }
    const started = ctx.subagents.startContinuable(spec)
    const snapshot = await waitTerminal(ctx, started.taskId, parent)
    expect(snapshot.status).toBe('failed')
    expect(snapshot.detail).toContain('maxDepth')
    // The unmaterialized child id is reported unavailable on later use.
    const followUp = await followup(ctx, parent, started.childId, message('hello?'))
    expect(followUp.route).toBe('started')
    const failed = await waitTerminal(ctx, followUp.taskId, parent)
    expect(failed.status).toBe('failed')
    expect(failed.detail).toContain('unavailable')
  })

  it('task_kill during the run aborts, disposes, and settles killed after quiescence', async () => {
    const { ctx, parent } = await setup(['hang'])
    const started = ctx.subagents.startContinuable(startSpec(parent))
    // Let the child publish and begin its turn.
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(ctx.agents.get(started.childId)).toBeDefined()
    expect(ctx.tasks.kill(started.taskId, parent, 'no longer needed')).toBe('requested')
    const snapshot = await waitTerminal(ctx, started.taskId, parent)
    expect(snapshot.status).toBe('killed')
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })

  it('task_kill during the final durability checkpoint settles killed', async () => {
    const { ctx, parent } = await setup([textResponse('driver answer')])
    const checkpointStarted = Promise.withResolvers<undefined>()
    const releaseCheckpoint = Promise.withResolvers<undefined>()
    let flushes = 0
    ctx.on('session/flush', async (session) => {
      if (session.header.parentSession === undefined) return
      flushes++
      if (flushes !== 2) return
      checkpointStarted.resolve(undefined)
      await releaseCheckpoint.promise
    })
    const started = ctx.subagents.startContinuable(startSpec(parent))

    await checkpointStarted.promise
    expect(ctx.tasks.kill(started.taskId, parent, 'no longer needed')).toBe('requested')
    releaseCheckpoint.resolve(undefined)

    const snapshot = await waitTerminal(ctx, started.taskId, parent)
    expect(snapshot.status).toBe('killed')
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })
})

describe('SubagentService.followup', () => {
  it('fails a cold-resume Task when the provider loses its resume capability', async () => {
    const { ctx, parent } = await setup([textResponse('first answer')])
    const started = ctx.subagents.startContinuable(startSpec(parent))
    await waitTerminal(ctx, started.taskId, parent)

    const provider = ctx.subagents.getProvider('spawn')!
    Object.defineProperty(provider, 'resume', { value: undefined, configurable: true })

    const next = await followup(ctx, parent, started.childId, message('continue'))
    const snapshot = await waitTerminal(ctx, next.taskId, parent)

    expect(snapshot.status).toBe('failed')
    expect(snapshot.detail).toContain('does not support resuming persisted children')
  })

  it('omits undeclared model selectors and rejects a provider without live delivery', async () => {
    const { ctx } = await setup([])
    const result = Promise.withResolvers<{
      output: { type: 'text'; text: string }[]
      stopReason: 'completed'
    }>()
    let descriptor: SessionEvent<'subagent/descriptor'>['data'] | undefined
    ctx.subagents.registerProvider({
      name: 'no-steer',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async (request) => {
        descriptor = request.continuation?.descriptor
        return {
          id: request.continuation!.sessionId,
          localAgent: undefined,
          result: result.promise,
          async dispose() {},
        }
      },
      resume: async () => { throw new Error('not used') },
    })
    const parent = ctx.agentLoop.create(SessionId('bare-parent'), {})
    const started = ctx.subagents.startContinuable(startSpec(parent, 'no-steer'))
    await waitPublishedRun(ctx, started.childId)

    expect(descriptor).toEqual({ version: SUBAGENT_DESCRIPTOR_VERSION, provider: 'no-steer' })
    await expect(followup(ctx, parent, started.childId, message('join')))
      .rejects.toThrow(/provider does not accept live delivery/)

    let terminalDeliveryError: unknown
    let terminalDelivery: Promise<void> | undefined
    ctx.tasks.onTaskDone((snapshot) => {
      if (snapshot.id !== started.taskId) return
      terminalDelivery = followup(ctx, parent, started.childId, message('after terminal')).then(
        () => undefined,
        (error: unknown) => {
          terminalDeliveryError = error
        },
      )
    })
    result.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' })
    await waitTerminal(ctx, started.taskId, parent)
    await terminalDelivery
    expect(String(terminalDeliveryError)).toContain('is completed')
  })

  it('rejects a registry agent different from the associated run agent', async () => {
    const { ctx, parent } = await setup([])
    const result = Promise.withResolvers<{
      output: { type: 'text'; text: string }[]
      stopReason: 'completed'
    }>()
    ctx.subagents.registerProvider({
      name: 'mismatched-local',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: async (request) => {
        const childId = request.continuation!.sessionId
        const handle = await ctx.agents.create({
          sessionId: childId,
          meta: { parentSession: request.parent.id },
          agentOptions: { provider: 'mock', model: 'mock' },
        })
        return {
          id: childId,
          localAgent: {} as Agent,
          result: result.promise,
          dispose: () => handle.dispose(),
        }
      },
      resume: async () => { throw new Error('not used') },
    })
    const started = ctx.subagents.startContinuable(startSpec(parent, 'mismatched-local'))
    await waitPublishedRun(ctx, started.childId)

    await expect(followup(ctx, parent, started.childId, message('join')))
      .rejects.toThrow(/registry agent is not the associated activation's agent/)
    result.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' })
    await waitTerminal(ctx, started.taskId, parent)
  })

  it('steers a running activation into the existing Task without creating a second Task', async () => {
    // Hold the child's first model call open so the child is observably
    // running when the message arrives; the steered content then drives a
    // second step in the SAME turn.
    let releaseFirst!: () => void
    const gate = new Promise<void>((resolve) => { releaseFirst = resolve })
    const adapter = new GatedAdapter([
      { chunks: textResponse('first step answer'), gate },
      { chunks: textResponse('steered turn answer') },
    ])
    const { ctx, parent } = await setupWith(adapter)

    const started = ctx.subagents.startContinuable(startSpec(parent))
    // Wait until the first immutable request has crossed the adapter boundary.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (adapter.requests.length === 1) {
          clearInterval(timer)
          resolve()
        }
      }, 5)
    })

    const delivery = ctx.subagents.followup(
      parent,
      started.childId,
      message('also consider Y'),
      { source: coordinatorSource, signal: testSendSignal },
    )
    releaseFirst()
    const delivered = await delivery
    expect(delivered).toEqual({ route: 'steered', taskId: started.taskId })
    const snapshot = await waitTerminal(ctx, started.taskId, parent)
    expect(snapshot.status).toBe('completed')
    // Exactly one Task exists: steering created none.
    expect(ctx.tasks.list(parent).map(task => task.id)).toEqual([started.taskId])
    // The steered content joined the SAME child turn and drove another step.
    const output = ctx.tasks.read(started.taskId, parent)
    expect(output.text).toBe('steered turn answer')
    const loaded = await ctx.sessionPersistence.load(started.childId)
    const steering = loaded.events.find(
      (event): event is SessionEvent<'steering/message'> => event.type === 'steering/message',
    )
    expect(steering?.data.message.source).toEqual(coordinatorSource)
  })

  it('cancels the active Task without enqueueing when live delivery is already aborted', async () => {
    const { ctx, parent, adapter } = await setup(['hang'])
    const started = ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const controller = new AbortController()
    controller.abort('caller already cancelled')

    await expect(followup(
      ctx,
      parent,
      started.childId,
      message('must not enqueue'),
      controller.signal,
    )).rejects.toMatchObject({ code: 'CANCELLED' })
    expect(ctx.agents.get(started.childId)).toBeUndefined()
    const snapshot = await waitTerminal(ctx, started.taskId, parent)
    expect(snapshot.status).toBe('killed')
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(loaded.events.some(event => event.type === 'steering/message')).toBe(false)
  })

  it('rejects before acknowledgement when terminal policy prevents steering admission', async () => {
    const { ctx, parent, adapter } = await setup([
      toolCallResponse('c1', 'structured_output', { answer: 7 }),
    ])
    const startedTool = Promise.withResolvers<undefined>()
    const releaseTool = Promise.withResolvers<undefined>()
    ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name === 'structured_output') {
        startedTool.resolve(undefined)
        await releaseTool.promise
      }
      return next()
    })

    const base = startSpec(parent)
    const started = ctx.subagents.startContinuable({
      ...base,
      request: {
        ...base.request,
        outputSchema: {
          type: 'object',
          properties: { answer: { type: 'number' } },
          required: ['answer'],
        },
      },
    })
    await startedTool.promise

    const delivery = ctx.subagents.followup(
      parent,
      started.childId,
      message('follow-up that terminal policy rejects'),
      { source: coordinatorSource, signal: testSendSignal },
    )
    releaseTool.resolve(undefined)
    await expect(delivery).rejects.toThrow(/message was not delivered/)

    const snapshot = await waitTerminal(ctx, started.taskId, parent)
    expect(snapshot.status).toBe('completed')
    expect(adapter.requests).toHaveLength(1)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(loaded.events.some(event => event.type === 'steering/message')).toBe(false)
  })

  it('cold-resumes a settled child into a fresh Task and reports `started`', async () => {
    const { ctx, parent } = await setup([textResponse('first answer'), textResponse('second answer')])
    const started = ctx.subagents.startContinuable(startSpec(parent))
    await waitTerminal(ctx, started.taskId, parent)
    expect(ctx.agents.get(started.childId)).toBeUndefined()

    const followUp = await ctx.subagents.followup(
      parent,
      started.childId,
      message('and then?'),
      { source: coordinatorSource, signal: testSendSignal },
    )
    expect(followUp.route).toBe('started')
    expect(followUp.taskId).not.toBe(started.taskId)
    const snapshot = await waitTerminal(ctx, followUp.taskId, parent)
    expect(snapshot.status).toBe('completed')
    expect(ctx.tasks.read(followUp.taskId, parent).text).toBe('second answer')
    // Fresh activation disposed again: durable child, no live Agent.
    expect(ctx.agents.get(started.childId)).toBeUndefined()

    // The durable transcript accumulated BOTH activations' turns.
    const loaded = await ctx.sessionPersistence.load(started.childId)
    const userMessages = loaded.events.filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
    expect(userMessages.map(event => (event.data.content[0] as { text: string }).text))
      .toEqual(['child task', 'and then?'])
    expect(userMessages.map(event => event.data.source))
      .toEqual([{ kind: 'user' }, coordinatorSource])
  })

  it('reconstructs the declared composition on cold resume', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('second')])
    const spec = {
      provider: 'spawn',
      label: 'scoped delegation',
      request: {
        prompt: [{ type: 'text' as const, text: 'child task' }],
        parent,
        persona: 'You are the resumable child.',
        toolFilter: { deny: [] as string[] },
      },
    }
    const started = ctx.subagents.startContinuable(spec)
    await waitTerminal(ctx, started.taskId, parent)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    const descriptor = loaded.events.find((event): event is SessionEvent<'subagent/descriptor'> => event.type === 'subagent/descriptor')
    expect(descriptor?.data.persona).toBe('You are the resumable child.')
    expect(descriptor?.data.toolFilter).toEqual({ deny: [] })

    const followUp = await followup(ctx, parent, started.childId, message('continue'))
    const snapshot = await waitTerminal(ctx, followUp.taskId, parent)
    expect(snapshot.status).toBe('completed')
    // The resumed child's system prompt carried the persona back.
    const resumed = await ctx.sessionPersistence.load(started.childId)
    const headers = resumed.events.filter((event): event is SessionEvent<'request/header'> => event.type === 'request/header')
    expect(headers.at(-1)?.data.header.system).toContain('You are the resumable child.')
  })

  it('fork children resume from their own transcript without re-forking parent history', async () => {
    const { ctx, parent } = await setup([
      textResponse('parent turn one'),
      textResponse('fork first answer'),
      textResponse('parent turn two'),
      textResponse('fork second answer'),
    ])
    parent.followup(createUserMessage({ content: message('parent question one'), source: { kind: 'user' } }))
    await parent.whenIdle()

    const started = ctx.subagents.startContinuable(startSpec(parent, 'fork'))
    await waitTerminal(ctx, started.taskId, parent)
    const firstLoad = await ctx.sessionPersistence.load(started.childId)
    const seedLength = firstLoad.meta.seedLength ?? 0
    expect(seedLength).toBeGreaterThan(0)

    // The parent gains NEW history the resume must not re-fork.
    parent.followup(createUserMessage({ content: message('parent question two'), source: { kind: 'user' } }))
    await parent.whenIdle()

    const followUp = await followup(ctx, parent, started.childId, message('follow up'))
    await waitTerminal(ctx, followUp.taskId, parent)
    const resumed = await ctx.sessionPersistence.load(started.childId)
    // The persisted seed boundary is unchanged and parent turn two is absent.
    expect(resumed.meta.seedLength).toBe(seedLength)
    const texts = resumed.events
      .filter((event): event is SessionEvent<'user/message'> => event.type === 'user/message')
      .map(event => (event.data.content[0] as { text: string }).text)
    expect(texts).toContain('parent question one')
    expect(texts).not.toContain('parent question two')
  })

  it('a resumed child cannot regain a top-level delegation budget (header floor)', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('second')])
    const started = ctx.subagents.startContinuable(startSpec(parent))
    await waitTerminal(ctx, started.taskId, parent)
    const followUp = await followup(ctx, parent, started.childId, message('go on'))

    const childAgents: Agent[] = []
    const stop = ctx.on('agent/created', (agent: Agent) => {
      if (agent.id === started.childId) childAgents.push(agent)
    })
    await waitTerminal(ctx, followUp.taskId, parent)
    stop()
    // The resumed runtime options carry no depth, so the header keeps the floor.
    const resumedChild = childAgents.at(-1)
    expect(resumedChild).toBeDefined()
    expect(resumedChild!.session.header.delegationDepth).toBe(1)
  })

  it('rejects a foreign child id: the started Task fails with UNAUTHORIZED and delivers nothing', async () => {
    const { ctx, parent } = await setup([textResponse('other parent answer'), textResponse('unused')])
    const otherParent = ctx.agentLoop.create(SessionId('other-parent'), { provider: 'mock', model: 'mock' })
    const started = ctx.subagents.startContinuable(startSpec(otherParent))
    await waitTerminal(ctx, started.taskId, otherParent)

    const attempt = await followup(ctx, parent, started.childId, message('mine now'))
    expect(attempt.route).toBe('started')
    const snapshot = await waitTerminal(ctx, attempt.taskId, parent)
    expect(snapshot.status).toBe('failed')
    expect(snapshot.detail).toContain('another parent session')
  })

  it('rejects a persisted child with no descriptor as not resumable', async () => {
    const { ctx, parent } = await setup([textResponse('plain child')])
    // A plain (non-continuable) child session persisted under this parent.
    const handle = await ctx.agents.create({
      sessionId: SessionId('plain-child'),
      meta: { parentSession: parent.id, delegationDepth: 1 },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    handle.agent.followup(createUserMessage({ content: message('do something'), source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    await handle.dispose()

    const attempt = await followup(ctx, parent, SessionId('plain-child'), message('continue?'))
    const snapshot = await waitTerminal(ctx, attempt.taskId, parent)
    expect(snapshot.status).toBe('failed')
    expect(snapshot.detail).toContain(
      'has no supported continuation state and cannot be resumed; do not retry send_message with this id',
    )
  })

  it('derives fallback and bounded labels for resumed activations', async () => {
    const { ctx, parent } = await setup([])
    const blank = await followup(ctx, parent, SessionId('blank-child'), message('   '))
    const longText = 'x'.repeat(100)
    const long = await followup(ctx, parent, SessionId('long-child'), message(longText))

    expect(ctx.tasks.get(blank.taskId, parent).label).toBe('subagent follow-up')
    expect(ctx.tasks.get(long.taskId, parent).label).toBe(`${'x'.repeat(79)}…`)
    await Promise.all([
      waitTerminal(ctx, blank.taskId, parent),
      waitTerminal(ctx, long.taskId, parent),
    ])
  })

  it('rejects delivery to a live agent outside continuation ownership', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    // A live child created outside continuation orchestration.
    const handle = await ctx.agents.create({
      sessionId: SessionId('rogue-child'),
      meta: { parentSession: parent.id },
      agentOptions: { provider: 'mock', model: 'mock' },
    })
    await expect(followup(ctx, parent, SessionId('rogue-child'), message('hello')))
      .rejects.toThrow(SubagentError)
    await expect(followup(ctx, parent, SessionId('rogue-child'), message('hello')))
      .rejects.toThrow(/outside continuation ownership.*not delivered/)
    await handle.dispose()
  })

  it('does not fall through to cold resume when steering loses the admission race', async () => {
    // Deterministic race: hold run disposal open so the association still
    // names a run whose child turn has already ended.
    const { ctx, parent } = await setup([textResponse('quick answer'), textResponse('unused')])
    let releaseDispose!: () => void
    const disposeGate = new Promise<void>((resolve) => { releaseDispose = resolve })
    const provider = ctx.subagents.getProvider('spawn')!
    const realStart = provider.start.bind(provider)
    provider.start = async (request) => {
      const run = await realStart(request)
      const realDispose = run.dispose.bind(run)
      return {
        ...run,
        ...run.steer !== undefined ? { steer: run.steer.bind(run) } : {},
        dispose: async () => {
          await disposeGate
          return realDispose()
        },
      }
    }

    const started = ctx.subagents.startContinuable(startSpec(parent))
    // Wait for the child to finish its turn while the run remains undisposed
    // and the association therefore still holds.
    await new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        const child = ctx.agents.get(started.childId)
        if (child !== undefined && child.status === 'idle'
          && child.session.events.some(event => event.type === 'turn/end')) {
          clearInterval(timer)
          resolve()
        }
      }, 5)
    })

    // Confirmed steering finds the settled child, fails loud, and does NOT start
    // a cold resume within this call.
    await expect(followup(ctx, parent, started.childId, message('too late?')))
      .rejects.toThrow(/not delivered/)
    expect(ctx.tasks.list(parent).map(task => task.id)).toEqual([started.taskId])
    releaseDispose()
    await waitTerminal(ctx, started.taskId, parent)
    // AFTER the Task settles, retry legitimately starts the next activation.
    const retry = await followup(ctx, parent, started.childId, message('retry'))
    expect(retry.route).toBe('started')
    await waitTerminal(ctx, retry.taskId, parent)
  })

  it('each follow-up Task result is fenced to the parent session', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('second')])
    const started = ctx.subagents.startContinuable(startSpec(parent))
    await waitTerminal(ctx, started.taskId, parent)
    const followUp = await followup(ctx, parent, started.childId, message('more'))
    const other = ctx.agentLoop.create(SessionId('intruder'), { provider: 'mock', model: 'mock' })
    expect(() => ctx.tasks.get(followUp.taskId, other)).toThrow(/belongs to another session/)
  })

  it('kills a cold-resume activation during descriptor lookup without starting child work', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('never used')])
    const started = ctx.subagents.startContinuable(startSpec(parent))
    await waitTerminal(ctx, started.taskId, parent)

    // Make the persistence load hang until the kill lands.
    const realLoad = ctx.sessionPersistence.load.bind(ctx.sessionPersistence)
    let releaseLoad!: () => void
    const gate = new Promise<void>((resolve) => { releaseLoad = resolve })
    ctx.sessionPersistence.load = async (id) => {
      await gate
      return realLoad(id)
    }

    const followUp = await followup(ctx, parent, started.childId, message('follow up'))
    expect(ctx.tasks.kill(followUp.taskId, parent)).toBe('requested')
    releaseLoad()
    const snapshot = await waitTerminal(ctx, followUp.taskId, parent)
    expect(snapshot.status).toBe('killed')
    // Cancellation during lookup prevented any child publication.
    expect(ctx.agents.get(started.childId)).toBeUndefined()
  })

  it('admits one process-local activation per child: a second send during resume load steers or fails, never duplicates', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('resumed answer')])
    const started = ctx.subagents.startContinuable(startSpec(parent))
    await waitTerminal(ctx, started.taskId, parent)

    const realLoad = ctx.sessionPersistence.load.bind(ctx.sessionPersistence)
    let releaseLoad!: () => void
    const gate = new Promise<void>((resolve) => { releaseLoad = resolve })
    ctx.sessionPersistence.load = async (id) => {
      await gate
      return realLoad(id)
    }

    const first = await followup(ctx, parent, started.childId, message('first follow-up'))
    expect(first.route).toBe('started')
    // The association is installed synchronously, so the competing caller
    // observes the pending activation instead of starting a duplicate resume.
    await expect(followup(ctx, parent, started.childId, message('second follow-up')))
      .rejects.toThrow(/not delivered/)
    releaseLoad()
    const snapshot = await waitTerminal(ctx, first.taskId, parent)
    expect(snapshot.status).toBe('completed')
    // Exactly one follow-up Task was created.
    expect(ctx.tasks.list(parent).map(task => task.id)).toEqual([started.taskId, first.taskId])
  })
})

describe('service disposal with live activations', () => {
  it('cancels and settles a starting activation on service disposal instead of stranding it', async () => {
    const ctx = new Context()
    await mountAgentLoopTestDependencies(ctx)
    const root = mkdtempSync(join(tmpdir(), 'dsh-subagent-continuation-hmr-'))
    roots.push(root)
    await ctx.plugin(JsonlSessionPersistence, { root })
    await ctx.plugin(AgentLoop, { agents: [] })
    const subagentsFiber = await ctx.plugin(SubagentService)
    await ctx.plugin(LocalTaskService)
    await ctx.plugin(ToolTasks, {})
    // A provider that stays pending until its signal aborts, so the activation
    // is observably mid-start when the subagent service is disposed.
    let sawAbort = false
    ctx.subagents.registerProvider({
      name: 'pending',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start: request => new Promise((_resolve, reject) => {
        request.signal.addEventListener('abort', () => {
          sawAbort = true
          reject(new Error('startup aborted'))
        }, { once: true })
      }),
      resume: () => Promise.reject(new Error('unreachable')),
    })
    ctx.llm.registerAdapter(['mock'], new MockAdapter([]))
    const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })

    const started = ctx.subagents.startContinuable({
      provider: 'pending',
      label: 'will be interrupted',
      request: { prompt: message('go'), parent },
    })
    // LocalTaskService keeps the producer Task; the disposing subagent service must
    // cancel its activation and await settlement rather than strand it.
    await subagentsFiber.dispose()
    expect(sawAbort).toBe(true)
    const snapshot = await waitTerminal(ctx, started.taskId, parent)
    expect(snapshot.status).toBe('killed')
  })
})

describe('outcome mapping helpers', () => {
  it.each([
    ['completed', { status: 'completed', output: 'partial' }],
    ['aborted', { status: 'killed' }],
    ['error', { status: 'failed', detail: 'error' }],
    ['max-tokens', { status: 'failed', detail: 'max-tokens' }],
    ['refusal', { status: 'failed', detail: 'refusal' }],
    ['paused', { status: 'failed', detail: 'paused' }],
  ] as const)('settleRun maps the %s stop reason onto its Task outcome', async (stopReason, expected) => {
    const output = [{ type: 'text' as const, text: 'partial' }]
    await expect(settleRun({
      id: SessionId('child'),
      localAgent: undefined,
      result: Promise.resolve({ output, stopReason: stopReason as never }),
      dispose: () => Promise.resolve(),
    })).resolves.toEqual(expected)
  })

  it('settleRun disposes the run before reporting, on both result paths', async () => {
    const order: string[] = []
    const completed = await settleRun({
      id: SessionId('child-1'),
      localAgent: undefined,
      result: Promise.resolve({ output: [{ type: 'text' as const, text: 'ok' }], stopReason: 'completed' as const }),
      dispose() { order.push('dispose'); return Promise.resolve() },
    })
    order.push('reported')
    expect(completed).toEqual({ status: 'completed', output: 'ok' })
    expect(order).toEqual(['dispose', 'reported'])

    // An infrastructure rejection still disposes and reports failed.
    let disposed = false
    const failed = await settleRun({
      id: SessionId('child-2'),
      localAgent: undefined,
      result: Promise.reject(new Error('transport gone')),
      dispose() { disposed = true; return Promise.resolve() },
    })
    expect(failed).toEqual({ status: 'failed', detail: 'Error: transport gone' })
    expect(disposed).toBe(true)

    const durabilityMessage = 'subagent "child-3" durability checkpoint failed; latest state unavailable: disk full'
    const durabilityFailed = await settleRun({
      id: SessionId('child-3'),
      localAgent: undefined,
      result: Promise.reject(new HarnessError(
        durabilityMessage,
        'DURABILITY_FAILED',
        { cause: new Error('disk full') },
      )),
      dispose: () => Promise.resolve(),
    })
    expect(durabilityFailed).toEqual({ status: 'failed', detail: durabilityMessage })

    const disposeFailed = await settleRun({
      id: SessionId('child-4'),
      localAgent: undefined,
      result: Promise.resolve({ output: [], stopReason: 'completed' }),
      dispose: () => Promise.reject(new Error('reap failed')),
    })
    expect(disposeFailed).toEqual({ status: 'failed', detail: 'dispose failed: Error: reap failed' })

    const bothFailed = await settleRun({
      id: SessionId('child-5'),
      localAgent: undefined,
      result: Promise.reject(new Error('result failed')),
      dispose: () => Promise.reject(new Error('reap failed')),
    })
    expect(bothFailed).toEqual({
      status: 'failed',
      detail: 'Error: result failed; dispose failed: Error: reap failed',
    })
  })
})
