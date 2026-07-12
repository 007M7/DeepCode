import { describe, expect, it, vi } from 'vitest'
import { Context, type Fiber } from 'cordis'
import LlmService from '@deepseek-ai/dsh-llm'
import SessionStore, { type SessionEvent } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import AgentRegistry, { AgentId, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as Invariants from '@deepseek-ai/dsh-invariants'
import SubagentService, { type SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { depthOf, type InProcessRunOptions, SubagentDepthError, startInProcessRun } from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

/**
 * Drives the shared in-process run driver DIRECTLY (no provider package), so the
 * driver's own contract — depth read/cap, the one-shot drive, the result read —
 * is covered independently of which backend (spawn/fork) calls it. The only
 * mocked boundary is the model; the real agent loop, SubagentService, and
 * dsh-invariants are mounted, so a malformed child session log fails the test.
 */
async function setup(script: Script) {
  const ctx = new Context()
  await ctx.plugin(LlmService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Invariants)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = ctx.agentLoop.create(AgentId('parent'), { model: 'mock' })
  return { ctx, parent }
}

function text(blocks: { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('depthOf', () => {
  it('reads 0 for an agent with no subagentDepth, the set value otherwise', async () => {
    const { parent } = await setup([])
    expect(depthOf(parent)).toBe(0)
    const withDepth = { options: { subagentDepth: 3 } } as unknown as Agent
    expect(depthOf(withDepth)).toBe(3)
  })

  it.each([
    { label: 'null', value: null as unknown as number },
    { label: 'a string', value: '1' as unknown as number },
    { label: 'NaN', value: Number.NaN },
    { label: 'positive infinity', value: Number.POSITIVE_INFINITY },
    { label: 'negative infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'a fraction', value: 1.5 },
    { label: 'a negative integer', value: -1 },
    { label: 'negative zero', value: -0 },
    { label: 'an unsafe integer', value: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects subagentDepth=$label', ({ value }) => {
    const agent = { options: { subagentDepth: value } } as unknown as Agent
    expect(() => depthOf(agent)).toThrow('agent subagentDepth must be a non-negative safe integer')
  })
})

describe('startInProcessRun', () => {
  it.each([
    { label: 'null', value: null as unknown as number },
    { label: 'a string', value: '1' as unknown as number },
    { label: 'NaN', value: Number.NaN },
    { label: 'positive infinity', value: Number.POSITIVE_INFINITY },
    { label: 'negative infinity', value: Number.NEGATIVE_INFINITY },
    { label: 'a fraction', value: 1.5 },
    { label: 'a negative integer', value: -1 },
    { label: 'negative zero', value: -0 },
    { label: 'an unsafe integer', value: Number.MAX_SAFE_INTEGER + 1 },
  ])('rejects maxDepth=$label before acquiring run ownership', async ({ value }) => {
    const { ctx, parent } = await setup([])
    expect(() => startInProcessRun(ctx, {
      prompt: [{ type: 'text', text: 'must never start' }],
      parent,
      maxDepth: value,
    }, {})).toThrow('subagent maxDepth must be a non-negative safe integer')
  })

  it('rejects a non-string persona before acquiring run ownership', async () => {
    const { ctx, parent } = await setup([])
    expect(() => startInProcessRun(ctx, {
      prompt: [{ type: 'text', text: 'must never start' }],
      parent,
      persona: 42 as unknown as string,
    }, {})).toThrow('subagent persona must be a string')
  })

  it('rejects a child depth with no safe-integer representation before acquiring run ownership', async () => {
    const { ctx } = await setup([])
    const parent = {
      options: { subagentDepth: Number.MAX_SAFE_INTEGER },
    } as unknown as Agent

    expect(() => startInProcessRun(ctx, {
      prompt: [{ type: 'text', text: 'must never start' }],
      parent,
    }, {})).toThrow(RangeError)
  })

  it('rejects a non-JSON prompt before acquiring any run ownership', async () => {
    const { ctx, parent } = await setup([])
    expect(() => startInProcessRun(ctx, {
      prompt: [{ type: 'text', text: Number.NaN as unknown as string }],
      parent,
    }, {})).toThrow('subagent prompt must be losslessly JSON-serializable')
  })

  it('reads each prompt value once before asynchronous child creation', async () => {
    const { ctx, parent } = await setup([])
    let reads = 0
    const prompt = [{
      type: 'text' as const,
      get text(): string {
        reads += 1
        return reads === 1 ? 'valid during pre-check' : Number.NaN as unknown as string
      },
    }]

    const run = startInProcessRun(ctx, { prompt, parent }, {})
    expect(reads).toBe(1)
    await run.dispose()
  })

  it('reads each public request and seed option field once', async () => {
    const { ctx, parent } = await setup([])
    const reads = { prompt: 0, toolFilter: 0, maxDepth: 0, outputSchema: 0, agentOptions: 0, persona: 0, seed: 0 }
    const request = Object.defineProperties({ parent }, {
      prompt: { enumerable: true, get: () => { reads.prompt += 1; return [{ type: 'text', text: 'accepted' }] } },
      toolFilter: { enumerable: true, get: () => { reads.toolFilter += 1; return reads.toolFilter === 1 ? undefined : { deny: ['ghost'] } } },
      maxDepth: { enumerable: true, get: () => { reads.maxDepth += 1; return reads.maxDepth === 1 ? undefined : 0 } },
      outputSchema: { enumerable: true, get: () => { reads.outputSchema += 1; return undefined } },
      agentOptions: { enumerable: true, get: () => { reads.agentOptions += 1; return {} } },
      persona: { enumerable: true, get: () => { reads.persona += 1; return undefined } },
    }) as unknown as SubagentStartRequest
    const options = Object.defineProperty({}, 'seed', {
      enumerable: true,
      get: () => { reads.seed += 1; return reads.seed === 1 ? undefined : [] },
    }) as InProcessRunOptions

    const run = startInProcessRun(ctx, request, options)

    expect(reads).toEqual({ prompt: 1, toolFilter: 1, maxDepth: 1, outputSchema: 1, agentOptions: 1, persona: 1, seed: 1 })
    await run.dispose()
  })

  it('rejects an exotic seed before asynchronous owner setup can sanitize it', async () => {
    const { ctx, parent } = await setup([])
    class ExoticSeedEvent {
      readonly type = 'turn/start'
      readonly seq = 0
      readonly time = 1
      readonly data = { turn: 1, trigger: { kind: 'message', source: { kind: 'user' } } }
    }

    expect(() => startInProcessRun(ctx, {
      prompt: [{ type: 'text', text: 'accepted' }],
      parent,
    }, { seed: [new ExoticSeedEvent()] as unknown as SessionEvent[] }))
      .toThrow(/subagent seed must be losslessly JSON-serializable/)
  })

  it.each([
    {
      label: 'tool filter',
      overrides: { toolFilter: { deny: [Number.NaN as unknown as string] } },
      message: 'subagent tool filter must be losslessly JSON-serializable',
    },
    {
      label: 'agent options',
      overrides: { agentOptions: { model: Number.NaN as unknown as string } },
      message: 'subagent agent options must be losslessly JSON-serializable',
    },
    {
      label: 'output schema',
      overrides: {
        outputSchema: {
          type: 'object',
          properties: { answer: { type: Number.NaN } },
        } as unknown as NonNullable<SubagentStartRequest['outputSchema']>,
      },
      message: 'schema annotation must be JSON data',
    },
  ])('rejects non-JSON $label before asynchronous child creation', async ({ overrides, message }) => {
    const { ctx, parent } = await setup([])

    expect(() => startInProcessRun(ctx, {
      prompt: [{ type: 'text', text: 'accepted' }],
      parent,
      ...overrides,
    }, {})).toThrow(message)
  })

  it('rejects a non-JSON model inherited from the parent before child creation', async () => {
    const { ctx, parent } = await setup([])
    const invalidParent = {
      options: { ...parent.options, model: Number.NaN as unknown as string },
      session: parent.session,
    } as unknown as Agent

    expect(() => startInProcessRun(ctx, {
      prompt: [{ type: 'text', text: 'accepted' }],
      parent: invalidParent,
    }, {})).toThrow('subagent agent options must be losslessly JSON-serializable')
  })

  it('rejects when the run-owner fiber settles without installing its context', async () => {
    const { ctx, parent } = await setup([])
    function inertOwner(): void {}
    const inertFiber = ctx.plugin(inertOwner)
    await inertFiber
    const parentWithoutOwnerContext = {
      options: parent.options,
      session: parent.session,
      ctx: { plugin: () => inertFiber },
    } as unknown as Agent

    const run = startInProcessRun(ctx, {
      prompt: [{ type: 'text', text: 'must never start' }],
      parent: parentWithoutOwnerContext,
    }, {})
    await expect(run.result).rejects.toThrow('subagent run owner became inactive before child creation')
    await run.dispose()
  })

  it('normalizes a non-Error thrown while installing the run-owner fiber', async () => {
    const { ctx, parent } = await setup([])
    const setupFailure = 'non-Error owner setup failure'
    const parentWithFailingOwnerSetup = {
      options: parent.options,
      session: parent.session,
      ctx: { plugin: () => { throw setupFailure } },
    } as unknown as Agent

    const run = startInProcessRun(ctx, {
      prompt: [{ type: 'text', text: 'must never start' }],
      parent: parentWithFailingOwnerSetup,
    }, {})
    await expect(run.result).rejects.toMatchObject({
      message: 'subagent run owner setup failed with a non-Error value',
      cause: setupFailure,
    })
    await run.dispose()
  })

  it('normalizes a non-Error rejected by asynchronous child creation', async () => {
    const { ctx, parent } = await setup([])
    const creationFailure = 'non-Error child creation failure'
    function inertOwner(): void {}
    const ownerFiber = ctx.plugin(inertOwner)
    await ownerFiber
    const rejectWithNonError = (): Promise<never> => {
      // Deliberately violate the promise contract to exercise boundary normalization.
      // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
      return Promise.reject(creationFailure)
    }
    const rejectingOwnerCtx = {
      agents: { create: rejectWithNonError },
    } as unknown as Context
    const parentWithRejectingFactory = {
      options: parent.options,
      session: parent.session,
      ctx: {
        plugin(plugin: (inner: Context) => void) {
          plugin(rejectingOwnerCtx)
          return ownerFiber
        },
      },
    } as unknown as Agent

    const run = startInProcessRun(ctx, {
      prompt: [{ type: 'text', text: 'must never start' }],
      parent: parentWithRejectingFactory,
    }, {})
    await expect(run.result).rejects.toMatchObject({
      message: 'subagent child creation failed with a non-Error value',
      cause: creationFailure,
    })
    await run.dispose()
  })

  it('follows owner-fiber inertia when raw teardown was already in flight', async () => {
    const { ctx, parent } = await setup([])
    const gate = Promise.withResolvers<undefined>()
    let inertia: Promise<undefined> | undefined = gate.promise
    const fakeFiber = {
      dispose: vi.fn(() => undefined),
      get inertia() { return inertia },
    } as unknown as Fiber & PromiseLike<Fiber>
    const rejectingOwnerCtx = {
      agents: { create: () => Promise.reject(new Error('creation stopped by teardown')) },
    } as unknown as Context
    const parentWithDisposingOwner = {
      options: parent.options,
      session: parent.session,
      ctx: {
        plugin(plugin: (inner: Context) => void) {
          plugin(rejectingOwnerCtx)
          return fakeFiber
        },
      },
    } as unknown as Agent
    const run = startInProcessRun(ctx, {
      prompt: [{ type: 'text', text: 'must never start' }],
      parent: parentWithDisposingOwner,
    }, {})

    let settled = false
    const disposing = run.dispose().then(() => { settled = true })
    await Promise.resolve()
    await Promise.resolve()
    expect(fakeFiber.dispose).toHaveBeenCalledOnce()
    expect(settled).toBe(false)

    inertia = undefined
    gate.resolve(undefined)
    await disposing
    await expect(run.result).resolves.toEqual({ output: [], stopReason: 'aborted' })
  })

  it('observes detached pre-readiness teardown failure and reports it to explicit dispose', async () => {
    const { ctx, parent } = await setup([])
    function inertOwner(): void {}
    const ownerFiber = ctx.plugin(inertOwner)
    await ownerFiber
    const disposeFailure = new Error('owner dispose exploded')
    const disposeSpy = vi.spyOn(ownerFiber, 'dispose').mockImplementation(() => { throw disposeFailure })
    const rejectingOwnerCtx = {
      agents: { create: () => Promise.reject(new Error('creation stopped by cancellation')) },
    } as unknown as Context
    const parentWithFailingTeardown = {
      options: parent.options,
      session: parent.session,
      ctx: {
        plugin(plugin: (inner: Context) => void) {
          plugin(rejectingOwnerCtx)
          return ownerFiber
        },
      },
    } as unknown as Agent
    const run = startInProcessRun(ctx, {
      prompt: [{ type: 'text', text: 'must never start' }],
      parent: parentWithFailingTeardown,
    }, {})

    run.cancel('cancel before readiness')
    await expect(run.result).resolves.toEqual({ output: [], stopReason: 'aborted' })
    await expect(run.dispose()).rejects.toBe(disposeFailure)
    disposeSpy.mockRestore()
    await ownerFiber.dispose()
  })

  it('does not attach an abort listener when provider ownership is already inactive', async () => {
    const { ctx, parent } = await setup([])
    let providerCtx: Context | undefined
    function provider(inner: Context): void { providerCtx = inner }
    const providerFiber = await ctx.plugin(provider)
    await providerFiber.dispose()
    if (providerCtx === undefined) throw new Error('provider context was not captured')
    const inactiveProviderCtx = providerCtx

    const controller = new AbortController()
    const addListener = vi.spyOn(controller.signal, 'addEventListener')
    expect(() => startInProcessRun(inactiveProviderCtx, {
      prompt: [{ type: 'text', text: 'must never start' }],
      parent,
      signal: controller.signal,
    }, {})).toThrow(/inactive context/)
    expect(addListener).not.toHaveBeenCalled()
  })

  it('drives a fresh child (no seed) to completion and returns its output', async () => {
    const { ctx, parent } = await setup([textResponse('driver child answer')])
    const run = startInProcessRun(ctx, { prompt: [{ type: 'text', text: 'do X' }], parent }, {})
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('driver child answer')
    expect(depthOf(ctx.agents.get(run.id)!)).toBe(1)
    await run.dispose()
  })

  it('snapshots the prompt before asynchronous child creation', async () => {
    const { ctx, parent } = await setup([textResponse('done')])
    const prompt = [{ type: 'text' as const, text: 'original prompt' }]
    const run = startInProcessRun(ctx, { prompt, parent }, {})

    prompt[0]!.text = 'mutated after start'
    prompt.push({ type: 'text', text: 'also injected' })
    await run.result

    const child = ctx.agents.get(run.id)!
    const userMessage = child.session.events.find(event => event.type === 'user/message')
    expect(userMessage?.type === 'user/message' && userMessage.data.content)
      .toEqual([{ type: 'text', text: 'original prompt' }])
    await run.dispose()
  })

  it('throws SubagentDepthError when the child would exceed maxDepth', async () => {
    const { ctx, parent } = await setup([])
    expect(() => startInProcessRun(ctx, { prompt: [{ type: 'text', text: 'p' }], parent, maxDepth: 0 }, {}))
      .toThrow(SubagentDepthError)
  })

  it('seeds the child session when a seed is supplied', async () => {
    // Drive the parent through one real turn, then seed the child with that
    // completed-turn prefix — the child must SEE the parent's history but its
    // result is scoped to its OWN events (not the seeded parent message).
    const { ctx, parent } = await setup([textResponse('parent turn'), textResponse('seeded child reply')])
    parent.send([{ type: 'text', text: 'parent q' }])
    await parent.whenIdle()
    const seed = parent.session.events.slice()
    const run = startInProcessRun(ctx, { prompt: [{ type: 'text', text: 'child q' }], parent }, { seed })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('seeded child reply')
    const child = ctx.agents.get(run.id)!
    // The child inherited the parent's prefix.
    expect(child.session.events.slice(0, seed.length).some(e => e.type === 'user/message')).toBe(true)
    await run.dispose()
  })
})
