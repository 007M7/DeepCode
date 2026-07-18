import { describe, expect, it } from 'vitest'
import { Context } from 'cordis'
import Loader from '@cordisjs/plugin-loader'
import AgentRegistry, { AgentId } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as Invariants from '@deepseek-ai/dsh-invariants'
import SubagentService, { type SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import * as fork from '../src/index.ts'
import { STRUCTURED_OUTPUT_TOOL } from '@deepseek-ai/dsh-subagent-inprocess'
import { completedTurnPrefix } from '../src/index.ts'

type Script = ConstructorParameters<typeof MockAdapter>[0]

function start(ctx: Context, provider: string, request: Omit<SubagentStartRequest, 'signal'> & { signal?: AbortSignal }) {
  return ctx.subagents.start(provider, { signal: request.signal ?? new AbortController().signal, ...request })
}

/** A bare `stop` finish that streams no content → the turn ends `completed`
 * with NO `assistant/message` of its own. */
const emptyStop: StreamChunk[] = [{ type: 'finish', reason: { kind: 'stop' } }]

/**
 * Drives the REAL fork backend with a real loop + scripted mock MODEL + the
 * real dsh-invariants plugin. The plugin replays a seeded child log on
 * `session/created`, so a malformed (unbalanced) fork seed makes these tests
 * THROW — that is the regression guard for the completed-turn-prefix boundary.
 */
async function setup(script: Script) {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(Invariants)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentService)
  await ctx.plugin(fork, { providerName: 'fork' })
  ctx.llm.registerAdapter(['mock'], new MockAdapter(script))
  const parent = ctx.agentLoop.create(AgentId('parent'), { provider: 'mock', model: 'mock' })
  return { ctx, parent }
}

function text(blocks: { type: string; text?: string }[]): string {
  return blocks.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('completedTurnPrefix', () => {
  it('returns an empty prefix for a parent that has never completed a turn', async () => {
    const { parent } = await setup([])
    expect(completedTurnPrefix(parent)).toEqual([])
  })

  it('returns the balanced prefix up to and including the last turn/end', async () => {
    const { parent } = await setup([textResponse('first'), textResponse('second')])
    parent.send([{ type: 'text', text: 'q1' }])
    await parent.whenIdle()
    parent.send([{ type: 'text', text: 'q2' }])
    await parent.whenIdle()

    const prefix = completedTurnPrefix(parent)
    // Ends exactly at the last turn/end; seq is contiguous from 0.
    expect(prefix.at(-1)?.type).toBe('turn/end')
    expect(prefix.map(e => e.seq)).toEqual(prefix.map((_, i) => i))
    // Both completed turns are present.
    expect(prefix.filter(e => e.type === 'turn/end')).toHaveLength(2)
  })
})

describe('dsh-subagent-fork', () => {
  it('emits subagent/start only after the seeded child is published', async () => {
    const { ctx, parent } = await setup([textResponse('child answer')])
    let childAtStart: ReturnType<typeof ctx.agents.get>
    ctx.on('subagent/start', (info) => {
      if (info.provider === 'fork') childAtStart = ctx.agents.get(info.id)
    })

    const starting = start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child q' }], parent })
    expect(childAtStart).toBeUndefined()
    const run = await starting
    expect(childAtStart).toBe(ctx.agents.get(run.id))
    expect(childAtStart?.id).toBe(run.id)

    await run.result
    await run.dispose()
  })

  it('forks an UNSEEDED (fresh) child when the parent has no completed turn', async () => {
    // The parent has never completed a turn → empty prefix → the provider omits
    // the seed → the child runs fresh. Exercises the `seed.length > 0` false arm.
    const { ctx, parent } = await setup([textResponse('fresh child')])
    expect(completedTurnPrefix(parent)).toEqual([])
    const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child q' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('fresh child')
    const child = ctx.agents.get(run.id)!
    // Only the child's own turn — no seeded parent turns.
    expect(child.session.events.filter(e => e.type === 'turn/end')).toHaveLength(1)
    await run.dispose()
  })

  it('seeds the child with the parent\'s completed-turn prefix (child inherits context)', async () => {
    // Parent runs one turn, then we fork. The child's seeded log should contain
    // the parent's first turn, and the child should run its own new turn on top.
    const { ctx, parent } = await setup([textResponse('parent answer'), textResponse('child answer')])
    parent.send([{ type: 'text', text: 'parent question' }])
    await parent.whenIdle()
    const parentPrefixLen = parent.session.events.length

    const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child question' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('child answer')

    const child = ctx.agents.get(run.id)!
    // The child's log STARTS with the parent's prefix (seeded), then its own turn.
    expect(child.session.events.length).toBeGreaterThan(parentPrefixLen)
    // The seeded prefix carried the parent's user message.
    const seededUser = child.session.events.slice(0, parentPrefixLen).find(e => e.type === 'user/message')
    expect(seededUser).toBeDefined()
    // Lineage stamped.
    expect(child.session.header.parentSession).toBe(parent.session.header.id)
    // The seed boundary is recorded on the header (= the seeded prefix length),
    // so a reload / replay harness can tell the inherited prefix from the
    // child's own events.
    expect(child.session.header.seedLength).toBe(parentPrefixLen)
    await run.dispose()
  })

  it('produces an invariant-CLEAN seed: forking mid-turn excludes the open turn', async () => {
    // Drive the parent so it has one completed turn, then start a SECOND turn that is still
    // open (a hanging model call), and fork while it's in flight. The seed must stop after the
    // balanced first turn; including the open turn would fail invariant replay during start.
    const { ctx, parent } = await setup([textResponse('done'), 'hang', textResponse('child')])
    parent.send([{ type: 'text', text: 'q1' }])
    await parent.whenIdle()
    // Start a second turn that hangs (open turn/start + open step, never ends).
    parent.send([{ type: 'text', text: 'q2' }])
    await new Promise(r => setTimeout(r, 20)) // let the hanging turn open

    // Forking now must NOT throw (the open second turn is excluded from the seed).
    const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child q' }], parent })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(text(result.output)).toBe('child')

    const child = ctx.agents.get(run.id)!
    // The child's seed has exactly the ONE completed parent turn (the open one excluded).
    const seedTurnEnds = child.session.events.filter(e => e.type === 'turn/end')
    // 1 from the seeded parent turn + 1 from the child's own completed turn.
    expect(seedTurnEnds.length).toBe(2)

    parent.cancel()
    await run.dispose()
  })

  it('captures structured output through the shipped plugin (seeded child, driver runtime)', async () => {
    const { ctx, parent } = await setup([
      textResponse('parent turn'),
      toolCallResponse('c1', STRUCTURED_OUTPUT_TOOL, { answer: 9 }),
    ])
    parent.send([{ type: 'text', text: 'warm up' }])
    await parent.whenIdle()
    const run = await start(ctx, 'fork', {
      prompt: [{ type: 'text', text: 'report structured' }],
      parent,
      outputSchema: { type: 'object', properties: { answer: { type: 'number' } }, required: ['answer'] },
    })
    const result = await run.result
    expect(result.stopReason).toBe('completed')
    expect(result.structured).toEqual({ answer: 9 })
    // Run-scoped runtime: nothing stays registered after the settle.
    expect(ctx.tools.get(STRUCTURED_OUTPUT_TOOL)).toBeUndefined()
    await run.dispose()
  })

  it('does NOT return the seeded parent output when the child produces no message of its own', async () => {
    // `readResult` must scan only child-owned events after the seed. The child emits no assistant
    // message, so scanning the whole log would incorrectly return the parent's distinctive text.
    const { ctx, parent } = await setup([textResponse('parent stale'), emptyStop])
    parent.send([{ type: 'text', text: 'parent question' }])
    await parent.whenIdle()

    const run = await start(ctx, 'fork', { prompt: [{ type: 'text', text: 'child question' }], parent })
    const result = await run.result
    // The child completed its own (empty) turn — completed, but with NO output
    // borrowed from the seeded parent prefix.
    expect(result.stopReason).toBe('completed')
    expect(result.output).toEqual([])
    await run.dispose()
  })

  it('advertises every start-time capability (depthLimit, outputSchema, toolFilter, persona)', async () => {
    const { ctx } = await setup([])
    expect(ctx.subagents.getProvider('fork')!.capabilities).toEqual({ outputSchema: true, depthLimit: true, toolFilter: true, persona: true })
  })

  it('unregisters the provider when its fiber is disposed (HMR safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SubagentService)
    await ctx.plugin(AgentRegistry)
    const fiber = await ctx.plugin(fork, { providerName: 'fork' })
    expect(ctx.subagents.list()).toEqual(['fork'])
    await fiber.dispose()
    expect(ctx.subagents.list()).toEqual([])
  })

  it('has the namespace-plugin export shape (no stray default)', () => {
    expect('default' in fork).toBe(false)
    expect(fork.name).toBe('subagent-fork')
    expect(fork.inject).toEqual(['subagents'])
    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(fork) as Record<string, unknown>
    expect(unwrapped).toBe(fork)
    expect(unwrapped.name).toBe('subagent-fork')
    expect(unwrapped.inject).toEqual(['subagents'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
