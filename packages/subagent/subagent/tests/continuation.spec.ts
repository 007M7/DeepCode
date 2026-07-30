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
import type { GenerateOptions, MessageId, StreamChunk } from '@deepseek-ai/dsh-llm'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentService, {
  SubagentError,
  SUBAGENT_DESCRIPTOR_VERSION,
} from '../src/index.ts'
import type { SubagentAuthority, SubagentRunEndInfo, SubagentRunInfo } from '../src/index.ts'

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

/** Boot the full continuable stack: loop, persistence, providers, and subagents. */
async function setupWith(adapter: LlmAdapter, options: { persistence?: boolean } = {}) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  let disposePersistence: (() => Promise<void>) | undefined
  let root: string | undefined
  if (options.persistence !== false) {
    root = mkdtempSync(join(tmpdir(), 'dsh-subagent-continuation-'))
    roots.push(root)
    const persistenceFiber = await ctx.plugin(JsonlSessionPersistence, { root })
    disposePersistence = () => persistenceFiber.dispose()
  }
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  await ctx.plugin(SubagentFork, { providerName: 'fork' })
  ctx.llm.registerAdapter(['mock'], adapter)
  const parent = ctx.agentLoop.create(SessionId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent, disposePersistence, root }
}

async function setup(script: Script, options: { persistence?: boolean } = {}) {
  const adapter = new MockAdapter(script)
  const booted = await setupWith(adapter, options)
  return { ...booted, adapter }
}

const testSignal = new AbortController().signal

function startSpec(parent: Agent, provider = 'spawn', signal: AbortSignal = testSignal) {
  return {
    provider,
    request: { prompt: [{ type: 'text' as const, text: 'child task' }], parent },
    signal,
  }
}

function message(text: string) {
  return [{ type: 'text' as const, text }]
}

function hasUserText(events: readonly SessionEvent[], text: string): boolean {
  return events.some(event => event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text === text))
}

/** Every user-role message text in log order, for FIFO assertions. */
function userTexts(events: readonly SessionEvent[]): string[] {
  return events.flatMap(event => event.type === 'user/message'
    ? event.data.content.flatMap(block => block.type === 'text' ? [block.text] : [])
    : [])
}

function followup(
  ctx: Context,
  authority: SubagentAuthority,
  childId: SessionId,
  content: ReturnType<typeof message>,
  signal: AbortSignal = testSignal,
) {
  return ctx.subagents.followup(authority, childId, content, {
    source: { kind: 'user' },
    signal,
  })
}

/** Wait until a child's Activation is gone, i.e. its handle finished disposal. */
async function waitNoActivation(ctx: Context, childId: SessionId): Promise<void> {
  await vi.waitFor(() => {
    expect(ctx.subagents.activationState(childId)).toBeUndefined()
    expect(ctx.agents.get(childId)).toBeUndefined()
  }, { timeout: 5_000 })
}

describe('SubagentService.startContinuable', () => {
  it('returns both identities at inbox acceptance, without waiting for the turn or the log', async () => {
    const { ctx, parent, adapter } = await setup([textResponse('first answer')])
    const enqueued: { id: MessageId; loggedYet: boolean }[] = []
    ctx.on('agent/inbox/enqueue', (agent, accepted) => {
      // Acceptance is the boundary `startContinuable` resolves at, so observe
      // the log state exactly there rather than after later microtasks.
      enqueued.push({ id: accepted.message.id, loggedYet: hasUserText(agent.session.events, 'child task') })
    })

    const started = await ctx.subagents.startContinuable(startSpec(parent))

    expect(started.childId).toMatch(/[0-9a-f-]{36}/)
    // The returned id is exactly the accepted inbox message's id, and nothing
    // was logged or requested to earn it.
    expect(enqueued).toEqual([{ id: started.messageId, loggedYet: false }])
    expect(adapter.requests).toEqual([])

    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'child task')).toBe(true)
  })

  it('rejects without ids when the provider has no prepareContinuable capability', async () => {
    const { ctx, parent } = await setup([])
    const start = vi.fn(async () => { throw new Error('must not dispatch') })
    ctx.subagents.registerProvider({
      name: 'one-shot',
      capabilities: { outputSchema: false, depthLimit: false, toolFilter: false, persona: false },
      inheritsParentContext: false,
      start,
    })

    await expect(ctx.subagents.startContinuable(startSpec(parent, 'one-shot')))
      .rejects.toThrow(/does not support continuable children/)
    expect(start).not.toHaveBeenCalled()
    // No child Agent and no session were created.
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('rejects synchronously when persistence is not configured', async () => {
    const { ctx, parent } = await setup([textResponse('unused')], { persistence: false })
    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toThrow(/require session persistence/)
  })

  it('publishes the reserved child id and appends the pre-turn descriptor', async () => {
    const { ctx, parent } = await setup([textResponse('answer')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    const descriptorIndex = loaded.events.findIndex(event => event.type === 'subagent/descriptor')
    const turnStartIndex = loaded.events.findIndex(event => event.type === 'turn/start')
    expect(descriptorIndex).toBeGreaterThanOrEqual(0)
    expect(descriptorIndex).toBeLessThan(turnStartIndex)
    const descriptor = loaded.events[descriptorIndex] as SessionEvent<'subagent/descriptor'>
    expect(descriptor.data).toEqual({
      version: SUBAGENT_DESCRIPTOR_VERSION,
      provider: 'spawn',
      agentProvider: 'mock',
      agentModel: 'mock',
    })
    // Model-hidden: the descriptor never carries surface metadata.
    expect('surfaceOp' in descriptor).toBe(false)
    expect(loaded.meta.id).toBe(started.childId)
    expect(loaded.meta.parentSession).toBe(SessionId('parent'))
  })

  it('rolls the child back completely when the caller signal aborts before acceptance', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    const controller = new AbortController()
    // Abort inside the child's creation window: setup runs before publication.
    ctx.on('agent/created', (child) => {
      if (child !== parent) controller.abort('caller gave up')
    })

    await expect(ctx.subagents.startContinuable(startSpec(parent, 'spawn', controller.signal)))
      .rejects.toThrow()
    // No Activation, no live child Agent, and no parent ownership remains.
    await vi.waitFor(() => {
      expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
    })
  })

  it('rejects a continuable child that would exceed the configured depth cap', async () => {
    const { ctx, parent } = await setup([])
    await expect(ctx.subagents.startContinuable({
      ...startSpec(parent),
      request: { prompt: message('deep'), parent, maxDepth: 0 },
    })).rejects.toThrow(/exceeds maxDepth 0/)
    expect(ctx.agents.list().map(agent => agent.id)).toEqual([SessionId('parent')])
  })

  it('records the declared persona in the descriptor and reapplies it on cold resume', async () => {
    const { ctx, parent } = await setup([textResponse('scoped'), textResponse('resumed')])
    const started = await ctx.subagents.startContinuable({
      ...startSpec(parent),
      request: {
        prompt: message('scoped work'),
        parent,
        persona: 'You are scoped.',
      },
    })
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    const descriptor = loaded.events.find(event => event.type === 'subagent/descriptor')
    expect(descriptor?.data).toMatchObject({ persona: 'You are scoped.' })

    // Cold resume reconstructs the declared composition from that descriptor.
    await followup(ctx, { kind: 'user' }, started.childId, message('resume it'))
    await waitNoActivation(ctx, started.childId)
    const resumed = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(resumed.events, 'resume it')).toBe(true)
  })
})

describe('SubagentService.followup residency routing', () => {
  it('enqueues in the same Activation while it is running, preserving one inbox FIFO', async () => {
    const releaseFirst = Promise.withResolvers<void>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first'), gate: releaseFirst.promise },
      { chunks: textResponse('second') },
      { chunks: textResponse('third') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    const child = ctx.agents.get(started.childId)
    expect(ctx.subagents.activationState(started.childId)).toBe('running')

    // Both origins queue behind the open turn, in call order.
    const parentMessage = await followup(ctx, { kind: 'parent', agent: parent }, started.childId, message('from parent'))
    const userMessage = await followup(ctx, { kind: 'user' }, started.childId, message('from user'))
    expect(parentMessage).not.toBe(userMessage)
    // Still the same Activation: no second child Agent was created.
    expect(ctx.agents.get(started.childId)).toBe(child)

    releaseFirst.resolve()
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(userTexts(loaded.events)).toEqual(['child task', 'from parent', 'from user'])
  })

  it('cold-resumes a settled child into a new Activation', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('after resume')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const messageId = await followup(ctx, { kind: 'user' }, started.childId, message('continue please'))
    expect(messageId).toBeTypeOf('string')
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(userTexts(loaded.events)).toEqual(['child task', 'continue please'])
    // One descriptor only: cold resume never re-seeds it.
    expect(loaded.events.filter(event => event.type === 'subagent/descriptor')).toHaveLength(1)
  })

  it('wakes a waiting Activation instead of cold-resuming it', async () => {
    const releaseGrandchild = Promise.withResolvers<void>()
    const adapter = new GatedAdapter([
      // The child delegates, then finishes its own turn while the grandchild runs.
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
      { chunks: textResponse('woken') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // The child starts its own continuable grandchild, then goes quiescent.
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(adapter.requests.length).toBeGreaterThanOrEqual(2) })
    await vi.waitFor(() => {
      expect(ctx.subagents.activationState(started.childId)).toBe('waiting')
    }, { timeout: 5_000 })
    // Waiting retains the handle: the same Agent is still live.
    expect(ctx.agents.get(started.childId)).toBe(child)

    await followup(ctx, { kind: 'user' }, started.childId, message('while waiting'))
    // Woken back to running on the SAME Activation.
    expect(ctx.agents.get(started.childId)).toBe(child)

    releaseGrandchild.resolve()
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(userTexts(loaded.events)).toEqual(['child task', 'while waiting'])
  })

  it('rejects a parent that is not the durable direct parent', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    const stranger = ctx.agentLoop.create(SessionId('stranger'), { provider: 'mock', model: 'mock' })

    await expect(followup(ctx, { kind: 'parent', agent: stranger }, started.childId, message('mine now')))
      .rejects.toThrow(/belongs to another parent session/)
  })

  it('lets user authority cold-resume a child without loading its historical parent', async () => {
    const { ctx, parent, root } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    await ctx.sessionPersistence.load(started.childId)

    // A fresh runtime over the same store has no parent Agent at all.
    const fresh = new Context()
    await mountAgentLoopTestDependencies(fresh)
    await fresh.plugin(JsonlSessionPersistence, { root: root! })
    await fresh.plugin(AgentLoop, { agents: [] })
    await fresh.plugin(SubagentService)
    await fresh.plugin(SubagentSpawn, { providerName: 'spawn' })
    fresh.llm.registerAdapter(['mock'], new MockAdapter([textResponse('resumed cold')]))
    expect(fresh.agents.get(SessionId('parent'))).toBeUndefined()

    await followup(fresh, { kind: 'user' }, started.childId, message('user continues'))
    await waitNoActivation(fresh, started.childId)

    const loaded = await fresh.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'user continues')).toBe(true)
    // The historical parent was never reconstructed.
    expect(fresh.agents.get(SessionId('parent'))).toBeUndefined()
  })

  it('reports an unresumable child whose persisted log has no supported descriptor', async () => {
    const { ctx, parent } = await setup([textResponse('one shot')])
    // A ONE-SHOT child persists a log but never seeds a descriptor.
    const run = await ctx.subagents.start('spawn', {
      prompt: message('one-shot work'),
      parent,
      signal: testSignal,
    })
    await run.result
    await ctx.sessions.flush(run.localAgent!.session)
    const oneShotId = run.id
    await run.dispose()

    await expect(followup(ctx, { kind: 'user' }, oneShotId, message('continue')))
      .rejects.toThrow(/no supported continuation state/)
  })

  it('reports an unknown child id as unavailable', async () => {
    const { ctx } = await setup([])
    await expect(followup(ctx, { kind: 'user' }, SessionId('missing'), message('hello')))
      .rejects.toMatchObject({ code: 'NOT_RESUMABLE' })
  })

  it('cold-resumes after losing a race with final disposal', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('after the race')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    // Send exactly while the Activation is settling: one side wins the cutoff,
    // and a delivery that loses waits for release and cold-resumes.
    await child.whenIdle()
    const delivery = followup(ctx, { kind: 'user' }, started.childId, message('raced'))

    await expect(delivery).resolves.toBeTypeOf('string')
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'raced')).toBe(true)
  })
})

describe('continuable child ownership', () => {
  it('keeps a parent Activation waiting until its child completes disposal', async () => {
    const releaseGrandchild = Promise.withResolvers<void>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild'), gate: releaseGrandchild.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))

    await vi.waitFor(() => {
      expect(ctx.subagents.activationState(started.childId)).toBe('waiting')
    }, { timeout: 5_000 })
    // Child-first: the parent handle is retained while the grandchild is live.
    expect(ctx.agents.get(started.childId)).toBe(child)
    expect(ctx.agents.get(grandchild.childId)).toBeDefined()

    releaseGrandchild.resolve()
    await waitNoActivation(ctx, grandchild.childId)
    await waitNoActivation(ctx, started.childId)
  })

  it('does not add a top-level parent to the waiting graph', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    // The top-level parent has no Activation of its own.
    expect(ctx.subagents.activationState(parent.id)).toBeUndefined()
    expect(ctx.agents.get(parent.id)).toBe(parent)
  })
})

describe('continuable durability and teardown', () => {
  it('reports DURABILITY_FAILED without leaking a waiting Activation', async () => {
    const releaseResponse = Promise.withResolvers<void>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('unconfirmed answer'), gate: releaseResponse.promise },
    ])
    const { ctx, parent, disposePersistence } = await setupWith(adapter)
    const warnings: string[] = []
    ctx.logger.warn = (message: string) => { warnings.push(message) }

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    // Remove every durability listener, so the final checkpoint cannot confirm.
    await disposePersistence!()
    releaseResponse.resolve()

    // The handle is still disposed and ownership released, so nothing is pinned.
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => {
      expect(warnings.some(warning => warning.includes('durability'))).toBe(true)
    })
  })

  it('disposes every live Activation forest child-first on manager teardown', async () => {
    const hold = Promise.withResolvers<void>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('child done') },
      { chunks: textResponse('grandchild'), gate: hold.promise },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    const child = await vi.waitFor(() => {
      const found = ctx.agents.get(started.childId)
      expect(found).toBeDefined()
      return found!
    })
    const grandchild = await ctx.subagents.startContinuable(startSpec(child))
    await vi.waitFor(() => { expect(ctx.agents.get(grandchild.childId)).toBeDefined() })

    const disposals: SessionId[] = []
    ctx.on('agent/disposed', (agent) => { disposals.push(agent.id) })
    const drained = ctx.subagents.drainContinuable()
    // Let the held model call observe its cancellation so quiescence can settle.
    hold.resolve()
    await drained

    // Child-first: the grandchild's disposal precedes its parent's.
    expect(disposals.indexOf(grandchild.childId)).toBeGreaterThanOrEqual(0)
    expect(disposals.indexOf(grandchild.childId))
      .toBeLessThan(disposals.indexOf(started.childId))
    // Durable sessions survive process-local teardown.
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(loaded.meta.id).toBe(started.childId)
  })

  it('rejects new materialization and delivery once draining begins', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    await ctx.subagents.drainContinuable()

    await expect(ctx.subagents.startContinuable(startSpec(parent)))
      .rejects.toMatchObject({ code: 'DRAINING' })
    await expect(followup(ctx, { kind: 'user' }, started.childId, message('too late')))
      .rejects.toMatchObject({ code: 'DRAINING' })
  })

  it('has no automatic replay for an accepted but unlogged message', async () => {
    const hold = Promise.withResolvers<void>()
    const adapter = new GatedAdapter([{ chunks: textResponse('first'), gate: hold.promise }])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })
    // Accepted into the inbox, but this queued turn never opens.
    await followup(ctx, { kind: 'user' }, started.childId, message('never logged'))

    const drained = ctx.subagents.drainContinuable()
    hold.resolve()
    await drained
    await waitNoActivation(ctx, started.childId)

    const loaded = await ctx.sessionPersistence.load(started.childId)
    // Only what actually reached the log is reconstructable.
    expect(hasUserText(loaded.events, 'never logged')).toBe(false)
  })
})

describe('continuable lifecycle observation', () => {
  it('emits one paired start/end per residency epoch', async () => {
    const { ctx, parent } = await setup([textResponse('first'), textResponse('second')])
    const starts: SubagentRunInfo[] = []
    const ends: SubagentRunEndInfo[] = []
    ctx.on('subagent/start', info => { starts.push(info) })
    ctx.on('subagent/end', info => { ends.push(info) })

    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(1) })

    // A cold resume is a NEW epoch with its own pair.
    await followup(ctx, { kind: 'user' }, started.childId, message('again'))
    await waitNoActivation(ctx, started.childId)
    await vi.waitFor(() => { expect(ends).toHaveLength(2) })

    expect(starts).toHaveLength(2)
    expect(starts.map(info => info.id)).toEqual([started.childId, started.childId])
    expect(starts.map(info => info.provider)).toEqual(['spawn', 'spawn'])
    // Each end pairs its own start's runId.
    expect(ends.map(info => info.runId)).toEqual(starts.map(info => info.runId))
  })
})

describe('continuable public surface', () => {
  it('exposes no cancellation, steering, or report operation', async () => {
    const { ctx } = await setup([])
    const subagents: Record<string, unknown> = ctx.subagents as unknown as Record<string, unknown>
    for (const absent of ['cancel', 'kill', 'steer', 'steerContinuable', 'report', 'resume']) {
      expect(subagents[absent]).toBeUndefined()
    }
    // No steering tool and no report tool are registered by this seam.
    const names = ctx.tools.schemas().map(schema => schema.name)
    expect(names).not.toContain('report')
    expect(names).not.toContain('steer_subagent')
  })

  it('keeps one-shot runs free of a steering capability', async () => {
    const { ctx, parent } = await setup([textResponse('one shot')])
    const run = await ctx.subagents.start('spawn', {
      prompt: message('one-shot work'),
      parent,
      signal: testSignal,
    })
    expect('steer' in run).toBe(false)
    await run.result
    await run.dispose()
  })

  it('reports a caller-signal abort before acceptance without delivering', async () => {
    const { ctx, parent } = await setup([textResponse('first')])
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await waitNoActivation(ctx, started.childId)

    const controller = new AbortController()
    controller.abort('caller gave up')
    await expect(followup(ctx, { kind: 'user' }, started.childId, message('aborted'), controller.signal))
      .rejects.toThrow()

    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'aborted')).toBe(false)
  })

  it('does not cancel an accepted turn when the caller signal aborts afterwards', async () => {
    const releaseFirst = Promise.withResolvers<void>()
    const adapter = new GatedAdapter([
      { chunks: textResponse('first'), gate: releaseFirst.promise },
      { chunks: textResponse('second') },
    ])
    const { ctx, parent } = await setupWith(adapter)
    const started = await ctx.subagents.startContinuable(startSpec(parent))
    await vi.waitFor(() => { expect(adapter.requests).toHaveLength(1) })

    const controller = new AbortController()
    await followup(ctx, { kind: 'user' }, started.childId, message('survives'), controller.signal)
    // After acceptance the manager owns the Activation independently.
    controller.abort('caller gave up')

    releaseFirst.resolve()
    await waitNoActivation(ctx, started.childId)
    const loaded = await ctx.sessionPersistence.load(started.childId)
    expect(hasUserText(loaded.events, 'survives')).toBe(true)
  })
})

describe('continuable errors', () => {
  it('rejects a second live Activation for the same durable child', async () => {
    const { ctx, parent } = await setup([textResponse('unused')])
    // Occupy the id with an unmanaged live Agent.
    const squatter = ctx.agentLoop.create(SessionId('squatted'), { provider: 'mock', model: 'mock' })
    await ctx.sessions.flush(squatter.session)
    await expect(followup(ctx, { kind: 'user' }, SessionId('squatted'), message('hello')))
      .rejects.toThrow(SubagentError)
    void parent
  })
})
